import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isAcpJsonRpcMessage } from "../acp/jsonrpc.js";
import { isProcessAlive } from "../process-liveness.js";
import type {
  AcpJsonRpcMessage,
  AcpMessageDirection,
  SessionRecord,
  SessionTimelineMetadata,
} from "../types.js";
import { SESSION_TIMELINE_SCHEMA } from "../types.js";
import { safeSessionId, sessionBaseDir, sessionEventActivePath } from "./event-log.js";
import { resolveSessionRecord, writeSessionRecord } from "./persistence.js";

export const SESSION_TIMELINE_EVENT_SCHEMA = "acpx.session_event.v1" as const;
export const SESSION_TIMELINE_GAP_SCHEMA = "acpx.session_history_gap.v1" as const;
const SESSION_TIMELINE_CURSOR_SCHEMA = "acpx.session_cursor.v1" as const;
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 1_000;
const REVERSE_READ_CHUNK_BYTES = 16 * 1024;
const LOCK_RETRY_MS = 15;

export type SessionTimelineDirection = AcpMessageDirection | "internal";

export type SessionTimelineLifecycleEvent =
  | { type: "turn_submitted" }
  | { type: "turn_started" }
  | { type: "turn_completed"; stop_reason?: string }
  | { type: "turn_failed"; message: string }
  | { type: "turn_cancelled" }
  | { type: "turn_interrupted" };

export type SessionTimelinePayload =
  | { kind: "acp"; message: AcpJsonRpcMessage }
  | { kind: "lifecycle"; event: SessionTimelineLifecycleEvent };

export type SessionTimelineEvent = {
  schema: typeof SESSION_TIMELINE_EVENT_SCHEMA;
  acpx_record_id: string;
  epoch: string;
  seq: number;
  captured_at: string;
  direction: SessionTimelineDirection;
  turn_id?: string;
  request_id?: string;
  payload: SessionTimelinePayload;
};

export type CapturedAcpTimelineEvent = {
  direction: AcpMessageDirection | "internal";
  message: AcpJsonRpcMessage;
  capturedAt: string;
  turnId?: string;
  requestId?: string;
};

export type SessionTimelineHistoryGap = {
  schema: typeof SESSION_TIMELINE_GAP_SCHEMA;
  kind: "history_gap";
  reason: "legacy_retained";
  message: string;
};

export type SessionTimelineItem = SessionTimelineHistoryGap | SessionTimelineEvent;

export type SessionTimelineCoverage = "complete" | "legacy_retained";

export type SessionTimelinePage = {
  items: SessionTimelineItem[];
  /** Pass this cursor to fetch the immediately preceding (older) window. */
  previousCursor?: string;
  hasMore: boolean;
  coverage: SessionTimelineCoverage;
};

export class SessionTimelineCursorError extends Error {
  readonly code: "CURSOR_INVALID" | "CURSOR_EXPIRED";
  readonly earliestCursor?: string;

  constructor(code: "CURSOR_INVALID" | "CURSOR_EXPIRED", message: string, earliestCursor?: string) {
    super(message);
    this.name = "SessionTimelineCursorError";
    this.code = code;
    this.earliestCursor = earliestCursor;
  }
}

type TimelineCursor = {
  schema: typeof SESSION_TIMELINE_CURSOR_SCHEMA;
  acpx_record_id: string;
  epoch: string;
  seq: number;
};

type TimelineLock = { filePath: string };

function timelinePath(sessionId: string, epoch: string): string {
  return path.join(
    sessionBaseDir(),
    `${safeSessionId(sessionId)}.timeline.${encodeURIComponent(epoch)}.ndjson`,
  );
}

function timelineLockPath(sessionId: string): string {
  return path.join(sessionBaseDir(), `${safeSessionId(sessionId)}.timeline.lock`);
}

function isoNow(): string {
  return new Date().toISOString();
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return 0;
  }
}

async function sessionHasLegacyEvents(record: SessionRecord): Promise<boolean> {
  return (
    record.lastSeq > 0 ||
    record.eventLog.last_write_at !== undefined ||
    (await fileSize(sessionEventActivePath(record.acpxRecordId))) > 0
  );
}

function parseLock(raw: string): { pid?: number; createdAt?: string } {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    const record = value as Record<string, unknown>;
    return {
      pid: typeof record.pid === "number" ? record.pid : undefined,
      createdAt: typeof record.created_at === "string" ? record.created_at : undefined,
    };
  } catch {
    return {};
  }
}

function lockOwnerIsAlive(pid: number | undefined): boolean {
  return pid === process.pid || isProcessAlive(pid);
}

async function removeStaleLock(filePath: string): Promise<boolean> {
  try {
    const parsed = parseLock(await fs.readFile(filePath, "utf8"));
    // Parked turns can hold the writer for an unbounded human decision. A live
    // owner is authoritative regardless of the lock's age.
    if (lockOwnerIsAlive(parsed.pid)) {
      return false;
    }
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function acquireTimelineLock(sessionId: string): Promise<TimelineLock> {
  await fs.mkdir(sessionBaseDir(), { recursive: true });
  const filePath = timelineLockPath(sessionId);
  const payload = `${JSON.stringify({ pid: process.pid, created_at: isoNow() })}\n`;
  for (;;) {
    try {
      await fs.writeFile(filePath, payload, { encoding: "utf8", flag: "wx" });
      return { filePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (await removeStaleLock(filePath)) {
        continue;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function releaseTimelineLock(lock: TimelineLock): Promise<void> {
  await fs.unlink(lock.filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isDirection(value: unknown): value is SessionTimelineDirection {
  return new Set<unknown>(["inbound", "outbound", "internal"]).has(value);
}

const LIFECYCLE_VALIDATORS: Record<string, (record: Record<string, unknown>) => boolean> = {
  turn_submitted: () => true,
  turn_started: () => true,
  turn_completed: (record) => isOptionalString(record.stop_reason),
  turn_failed: (record) => typeof record.message === "string",
  turn_cancelled: () => true,
  turn_interrupted: () => true,
};

function isLifecycleEvent(value: unknown): value is SessionTimelineLifecycleEvent {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") {
    return false;
  }
  return LIFECYCLE_VALIDATORS[record.type]?.(record) ?? false;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function hasTimelineEnvelopeCore(record: Record<string, unknown>): boolean {
  return [
    record.schema === SESSION_TIMELINE_EVENT_SCHEMA,
    typeof record.acpx_record_id === "string",
    typeof record.epoch === "string",
    isPositiveInteger(record.seq),
    typeof record.captured_at === "string",
    isDirection(record.direction),
    isOptionalString(record.turn_id),
    isOptionalString(record.request_id),
  ].every(Boolean);
}

function hasValidTimelinePayload(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) {
    return false;
  }
  const validators: Record<string, () => boolean> = {
    acp: () => isAcpJsonRpcMessage(payload.message),
    lifecycle: () => isLifecycleEvent(payload.event),
  };
  return typeof payload.kind === "string" && (validators[payload.kind]?.() ?? false);
}

function parseTimelineEvent(value: unknown): SessionTimelineEvent | undefined {
  const record = asRecord(value);
  if (
    !record ||
    !hasTimelineEnvelopeCore(record) ||
    !hasValidTimelinePayload(asRecord(record.payload))
  ) {
    return undefined;
  }
  return value as SessionTimelineEvent;
}

function stringOrNumber(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function firstRequestId(values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = stringOrNumber(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function requestIdFromMessage(message: AcpJsonRpcMessage): string | undefined {
  if (Object.hasOwn(message, "id")) {
    const id = stringOrNumber((message as { id?: unknown }).id);
    if (id !== undefined) {
      return id;
    }
  }
  const params = asRecord((message as { params?: unknown }).params);
  const request = asRecord(params?.request);
  return firstRequestId([
    params?.requestId,
    params?.request_id,
    request?.requestId,
    request?.request_id,
  ]);
}

export function captureAcpTimelineEvent(
  direction: SessionTimelineDirection,
  message: AcpJsonRpcMessage,
  association: { turnId?: string; requestId?: string } = {},
): CapturedAcpTimelineEvent {
  return {
    direction,
    message,
    capturedAt: isoNow(),
    turnId: association.turnId,
    requestId: association.requestId ?? requestIdFromMessage(message),
  };
}

async function initializeMetadata(record: SessionRecord): Promise<SessionTimelineMetadata> {
  if (record.timeline) {
    return record.timeline;
  }
  const persisted = await resolveSessionRecord(record.acpxRecordId).catch(() => undefined);
  if (persisted?.timeline) {
    record.timeline = persisted.timeline;
    return record.timeline;
  }
  const createdAt = isoNow();
  const epoch = randomUUID();
  const metadata: SessionTimelineMetadata = {
    schema: SESSION_TIMELINE_SCHEMA,
    epoch,
    last_seq: 0,
    active_path: timelinePath(record.acpxRecordId, epoch),
    created_at: createdAt,
    legacy_retained: await sessionHasLegacyEvents(record),
  };
  record.timeline = metadata;
  return metadata;
}

export class SessionTimelineWriter {
  private readonly record: SessionRecord;
  private readonly lock: TimelineLock;
  private readonly metadata: SessionTimelineMetadata;
  private closed = false;

  private constructor(
    record: SessionRecord,
    lock: TimelineLock,
    metadata: SessionTimelineMetadata,
  ) {
    this.record = record;
    this.lock = lock;
    this.metadata = metadata;
  }

  static async open(record: SessionRecord): Promise<SessionTimelineWriter> {
    const lock = await acquireTimelineLock(record.acpxRecordId);
    try {
      const metadata = await initializeMetadata(record);
      const [latest] = await readTimelineEventsBackward(record.acpxRecordId, metadata, {
        limit: 1,
      });
      metadata.last_seq = latest?.seq ?? 0;
      return new SessionTimelineWriter(record, lock, metadata);
    } catch (error) {
      await releaseTimelineLock(lock);
      throw error;
    }
  }

  async appendAcpEvents(events: CapturedAcpTimelineEvent[]): Promise<void> {
    for (const event of events) {
      if (!isAcpJsonRpcMessage(event.message)) {
        throw new Error("Attempted to persist invalid ACP JSON-RPC payload in session timeline");
      }
      await this.append({
        direction: event.direction,
        capturedAt: event.capturedAt,
        turnId: event.turnId,
        requestId: event.requestId ?? requestIdFromMessage(event.message),
        payload: { kind: "acp", message: event.message },
      });
    }
  }

  async appendLifecycleEvent(
    event: SessionTimelineLifecycleEvent,
    association: { capturedAt?: string; turnId?: string; requestId?: string } = {},
  ): Promise<void> {
    await this.append({
      direction: "internal",
      capturedAt: association.capturedAt ?? isoNow(),
      turnId: association.turnId,
      requestId: association.requestId,
      payload: { kind: "lifecycle", event },
    });
  }

  private async append(input: {
    direction: SessionTimelineDirection;
    capturedAt: string;
    turnId?: string;
    requestId?: string;
    payload: SessionTimelinePayload;
  }): Promise<void> {
    if (this.closed) {
      throw new Error("SessionTimelineWriter is closed");
    }
    const envelope: SessionTimelineEvent = {
      schema: SESSION_TIMELINE_EVENT_SCHEMA,
      acpx_record_id: this.record.acpxRecordId,
      epoch: this.metadata.epoch,
      seq: this.metadata.last_seq + 1,
      captured_at: input.capturedAt,
      direction: input.direction,
      turn_id: input.turnId,
      request_id: input.requestId,
      payload: input.payload,
    };
    await fs.mkdir(path.dirname(this.metadata.active_path), { recursive: true });
    await fs.appendFile(this.metadata.active_path, `${JSON.stringify(envelope)}\n`, "utf8");
    this.metadata.last_seq = envelope.seq;
    this.metadata.last_write_at = isoNow();
  }

  async close(options: { checkpoint?: boolean } = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      if (options.checkpoint === true) {
        await writeSessionRecord(this.record);
      }
    } finally {
      this.closed = true;
      await releaseTimelineLock(this.lock);
    }
  }
}

export async function appendSessionTimelineLifecycleEvent(
  record: SessionRecord,
  event: SessionTimelineLifecycleEvent,
  association: { capturedAt?: string; turnId?: string; requestId?: string } = {},
): Promise<void> {
  const writer = await SessionTimelineWriter.open(record);
  try {
    await writer.appendLifecycleEvent(event, association);
    await writer.close({ checkpoint: true });
  } catch (error) {
    await writer.close().catch(() => undefined);
    throw error;
  }
}

type ReverseTimelineReadOptions = {
  beforeSeq?: number;
  limit: number;
  predicate?: (event: SessionTimelineEvent) => boolean;
  onBytesRead?: (bytes: number) => void;
};

function matchingTimelineLine(
  line: Buffer,
  sessionId: string,
  metadata: SessionTimelineMetadata,
  options: ReverseTimelineReadOptions,
): SessionTimelineEvent | undefined {
  if (line.length === 0) {
    return undefined;
  }
  try {
    const event = parseTimelineEvent(JSON.parse(line.toString("utf8")) as unknown);
    if (!event || !timelineEventMatches(event, sessionId, metadata, options)) {
      return undefined;
    }
    return event;
  } catch {
    return undefined;
  }
}

function timelineEventMatches(
  event: SessionTimelineEvent,
  sessionId: string,
  metadata: SessionTimelineMetadata,
  options: ReverseTimelineReadOptions,
): boolean {
  return [
    event.acpx_record_id === sessionId,
    event.epoch === metadata.epoch,
    event.seq < (options.beforeSeq ?? Number.POSITIVE_INFINITY),
    options.predicate?.(event) ?? true,
  ].every(Boolean);
}

function newlineBoundaries(data: Buffer): number[] {
  const boundaries: number[] = [];
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] === 0x0a) {
      boundaries.push(index);
    }
  }
  return boundaries;
}

function appendMatchingLine(
  params: Parameters<typeof consumeCompleteLines>[0],
  start: number,
  end: number,
): boolean {
  const event = matchingTimelineLine(
    params.data.subarray(start, end),
    params.sessionId,
    params.metadata,
    params.options,
  );
  if (event) {
    params.result.push(event);
  }
  return params.result.length >= params.options.limit;
}

function consumeReverseSegments(
  params: Parameters<typeof consumeCompleteLines>[0],
  boundaries: number[],
  firstCompleteStart: number,
): { end: number; full: boolean } {
  let end = params.data.length;
  for (const boundary of boundaries.toReversed()) {
    const start = boundary + 1;
    if (start < firstCompleteStart) {
      break;
    }
    if (appendMatchingLine(params, start, end)) {
      return { end, full: true };
    }
    end = boundary;
  }
  return { end, full: false };
}

function finishLineConsumption(
  params: Parameters<typeof consumeCompleteLines>[0],
  boundaries: number[],
  consumed: { end: number; full: boolean },
): Buffer {
  if (consumed.full) {
    return Buffer.alloc(0);
  }
  if (params.startsAtFileBeginning && consumed.end > 0) {
    appendMatchingLine(params, 0, consumed.end);
    return Buffer.alloc(0);
  }
  return params.data.subarray(0, boundaries[0] ?? params.data.length);
}

function consumeCompleteLines(params: {
  data: Buffer;
  startsAtFileBeginning: boolean;
  sessionId: string;
  metadata: SessionTimelineMetadata;
  options: ReverseTimelineReadOptions;
  result: SessionTimelineEvent[];
}): Buffer {
  const boundaries = newlineBoundaries(params.data);
  const firstCompleteStart = params.startsAtFileBeginning ? 0 : (boundaries[0] ?? -1) + 1;
  if (firstCompleteStart === 0 && !params.startsAtFileBeginning) {
    return params.data;
  }
  const consumed = consumeReverseSegments(params, boundaries, firstCompleteStart);
  return finishLineConsumption(params, boundaries, consumed);
}

async function readTimelineEventsBackward(
  sessionId: string,
  metadata: SessionTimelineMetadata,
  options: ReverseTimelineReadOptions,
): Promise<SessionTimelineEvent[]> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(metadata.active_path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  try {
    let position = (await handle.stat()).size;
    let carry = Buffer.alloc(0);
    const result: SessionTimelineEvent[] = [];
    while (position > 0 && result.length < options.limit) {
      const bytesToRead = Math.min(REVERSE_READ_CHUNK_BYTES, position);
      const start = position - bytesToRead;
      const chunk = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(chunk, 0, bytesToRead, start);
      options.onBytesRead?.(bytesRead);
      const data = Buffer.concat([chunk.subarray(0, bytesRead), carry]);
      carry = Buffer.from(
        consumeCompleteLines({
          data,
          startsAtFileBeginning: start === 0,
          sessionId,
          metadata,
          options,
          result,
        }),
      );
      position = start;
    }
    return result;
  } finally {
    await handle.close();
  }
}

function encodeCursor(sessionId: string, epoch: string, seq: number): string {
  const cursor: TimelineCursor = {
    schema: SESSION_TIMELINE_CURSOR_SCHEMA,
    acpx_record_id: sessionId,
    epoch,
    seq,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function isTimelineCursor(value: unknown): value is TimelineCursor {
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  return [
    record.schema === SESSION_TIMELINE_CURSOR_SCHEMA,
    typeof record.acpx_record_id === "string",
    typeof record.epoch === "string",
    typeof record.seq === "number",
    Number.isInteger(record.seq),
    typeof record.seq === "number" && record.seq >= 0,
  ].every(Boolean);
}

function decodeCursor(raw: string): TimelineCursor {
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!isTimelineCursor(value)) {
      throw new Error("invalid cursor payload");
    }
    return value;
  } catch {
    throw new SessionTimelineCursorError("CURSOR_INVALID", "Invalid session timeline cursor");
  }
}

function assertCursorSession(cursor: TimelineCursor | undefined, record: SessionRecord): void {
  if (cursor && cursor.acpx_record_id !== record.acpxRecordId) {
    throw new SessionTimelineCursorError("CURSOR_INVALID", "Cursor belongs to another session");
  }
}

function pageWithoutTimeline(
  record: SessionRecord,
  cursor: TimelineCursor | undefined,
): SessionTimelinePage {
  if (cursor) {
    throw new SessionTimelineCursorError("CURSOR_EXPIRED", "Session timeline epoch is unavailable");
  }
  const gap = legacyGap(record);
  return {
    items: gap,
    hasMore: false,
    coverage: gap.length > 0 ? "legacy_retained" : "complete",
  };
}

function assertCursorEpoch(
  cursor: TimelineCursor | undefined,
  record: SessionRecord,
  metadata: SessionTimelineMetadata,
): void {
  if (cursor && cursor.epoch !== metadata.epoch) {
    throw new SessionTimelineCursorError(
      "CURSOR_EXPIRED",
      "Session timeline cursor belongs to an expired epoch",
      encodeCursor(record.acpxRecordId, metadata.epoch, 0),
    );
  }
}

function normalizePageLimit(value: number | undefined): number {
  const finite = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_PAGE_LIMIT;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.trunc(finite)));
}

function timelineCoverage(metadata: SessionTimelineMetadata): SessionTimelineCoverage {
  return metadata.legacy_retained ? "legacy_retained" : "complete";
}

function timelinePageItems(
  record: SessionRecord,
  metadata: SessionTimelineMetadata,
  hasMore: boolean,
  selected: SessionTimelineEvent[],
): SessionTimelineItem[] {
  const prefix = !hasMore && metadata.legacy_retained ? legacyGap(record) : [];
  return [...prefix, ...selected];
}

function pageFromEvents(params: {
  record: SessionRecord;
  metadata: SessionTimelineMetadata;
  newestFirstEvents: SessionTimelineEvent[];
  limit: number;
}): SessionTimelinePage {
  const hasMore = params.newestFirstEvents.length > params.limit;
  const selected = params.newestFirstEvents.slice(0, params.limit).toReversed();
  const first = selected[0];
  return {
    items: timelinePageItems(params.record, params.metadata, hasMore, selected),
    previousCursor:
      hasMore && first
        ? encodeCursor(params.record.acpxRecordId, params.metadata.epoch, first.seq)
        : undefined,
    hasMore,
    coverage: timelineCoverage(params.metadata),
  };
}

export async function listSessionTimelinePage(
  sessionId: string,
  options: { before?: string; limit?: number } = {},
): Promise<SessionTimelinePage> {
  const record = await resolveSessionRecord(sessionId);
  const metadata = record.timeline;
  const cursor = options.before ? decodeCursor(options.before) : undefined;
  assertCursorSession(cursor, record);
  if (!metadata) {
    return pageWithoutTimeline(record, cursor);
  }
  assertCursorEpoch(cursor, record, metadata);
  const limit = normalizePageLimit(options.limit);
  const events = await readTimelineEventsBackward(record.acpxRecordId, metadata, {
    beforeSeq: cursor?.seq,
    limit: limit + 1,
  });
  return pageFromEvents({
    record,
    metadata,
    newestFirstEvents: events,
    limit,
  });
}

/** Return the newest durable envelope without requiring a forward scan by callers. */
export async function getLatestSessionTimelineEvent(
  sessionId: string,
): Promise<SessionTimelineEvent | undefined> {
  const record = await resolveSessionRecord(sessionId);
  if (!record.timeline) {
    return undefined;
  }
  return (await readTimelineEventsBackward(record.acpxRecordId, record.timeline, { limit: 1 }))[0];
}

/** Return the newest turn lifecycle envelope, skipping later raw ACP traffic. */
export async function getLatestSessionTimelineLifecycleEvent(
  sessionId: string,
): Promise<SessionTimelineEvent | undefined> {
  const record = await resolveSessionRecord(sessionId);
  if (!record.timeline) {
    return undefined;
  }
  return (
    await readTimelineEventsBackward(record.acpxRecordId, record.timeline, {
      limit: 1,
      predicate: (event) => event.payload.kind === "lifecycle",
    })
  )[0];
}

function terminalLifecycleTurnId(event: SessionTimelineEvent): string | undefined {
  if (event.payload.kind !== "lifecycle") {
    return undefined;
  }
  const terminalTypes = new Set([
    "turn_completed",
    "turn_failed",
    "turn_cancelled",
    "turn_interrupted",
  ]);
  return terminalTypes.has(event.payload.event.type) ? event.turn_id : undefined;
}

/**
 * Resolve the newest started turn that has no later terminal lifecycle event.
 * Newer queued `turn_submitted` envelopes do not hide the currently active turn.
 */
export async function getActiveSessionTimelineTurn(
  sessionId: string,
): Promise<SessionTimelineEvent | undefined> {
  const record = await resolveSessionRecord(sessionId);
  if (!record.timeline) {
    return undefined;
  }
  const settled = new Set<string>();
  return (
    await readTimelineEventsBackward(record.acpxRecordId, record.timeline, {
      limit: 1,
      predicate: (event) => {
        const terminalTurnId = terminalLifecycleTurnId(event);
        if (terminalTurnId) {
          settled.add(terminalTurnId);
          return false;
        }
        return (
          event.payload.kind === "lifecycle" &&
          event.payload.event.type === "turn_started" &&
          typeof event.turn_id === "string" &&
          !settled.has(event.turn_id)
        );
      },
    })
  )[0];
}

function legacyGap(record: SessionRecord): SessionTimelineHistoryGap[] {
  const hasLegacy = record.timeline?.legacy_retained === true || record.lastSeq > 0;
  return hasLegacy
    ? [
        {
          schema: SESSION_TIMELINE_GAP_SCHEMA,
          kind: "history_gap",
          reason: "legacy_retained",
          message:
            "History before the lossless timeline was enabled is available only as retained legacy data.",
        },
      ]
    : [];
}

export async function deleteSessionTimeline(sessionId: string): Promise<number> {
  const directory = sessionBaseDir();
  const prefix = `${safeSessionId(sessionId)}.timeline.`;
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  let bytes = 0;
  for (const name of names) {
    if (!name.startsWith(prefix) || (!name.endsWith(".ndjson") && name !== `${prefix}lock`)) {
      continue;
    }
    const filePath = path.join(directory, name);
    bytes += await fileSize(filePath);
    await fs.unlink(filePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
  }
  return bytes;
}

export const sessionTimelineTestInternals = { removeStaleLock, readTimelineEventsBackward };
