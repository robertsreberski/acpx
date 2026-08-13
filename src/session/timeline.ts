import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isAcpJsonRpcMessage } from "../acp/jsonrpc.js";
import { isProcessAlive } from "../process-liveness.js";
import type {
  AcpJsonRpcMessage,
  AcpMessageDirection,
  SessionRecord,
  SessionTimelineLegacyImportSource,
  SessionTimelineMetadata,
} from "../types.js";
import { SESSION_TIMELINE_SCHEMA } from "../types.js";
import {
  safeSessionId,
  sessionBaseDir,
  sessionEventActivePath,
  sessionEventSegmentPath,
} from "./event-log.js";
import { resolveSessionRecord, writeSessionRecord } from "./persistence.js";

export const SESSION_TIMELINE_EVENT_SCHEMA = "acpx.session_event.v1" as const;
export const SESSION_TIMELINE_GAP_SCHEMA = "acpx.session_history_gap.v1" as const;
const SESSION_TIMELINE_CURSOR_SCHEMA = "acpx.session_cursor.v1" as const;
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 1_000;
const REVERSE_READ_CHUNK_BYTES = 16 * 1024;
const LOCK_RETRY_MS = 15;
const LEGACY_READ_CHUNK_BYTES = 64 * 1024;
export const LEGACY_IMPORT_MAX_BYTES_PER_READ = 4 * 1024 * 1024;
export const LEGACY_IMPORT_MAX_MESSAGES_PER_READ = 2_048;

export type SessionTimelineDirection = AcpMessageDirection | "internal";

export type SessionTimelineLifecycleEvent =
  | { type: "turn_submitted"; prompt_text?: string }
  | { type: "turn_started" }
  | { type: "turn_completed"; stop_reason?: string }
  | { type: "turn_failed"; message: string }
  | { type: "turn_cancelled" }
  | { type: "turn_interrupted" };

export type SessionTimelineLegacyCursor = {
  source_identity: string;
  end_offset: number;
};

export type SessionTimelinePayload =
  | {
      kind: "acp";
      message: AcpJsonRpcMessage;
      source?: "legacy_stream";
      legacy_cursor?: SessionTimelineLegacyCursor;
    }
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
  source?: "legacy_stream";
};

export type SessionTimelineHistoryGap = {
  schema: typeof SESSION_TIMELINE_GAP_SCHEMA;
  kind: "history_gap";
  reason: "legacy_retained" | "corrupt";
  message: string;
};

export type SessionTimelineItem = SessionTimelineHistoryGap | SessionTimelineEvent;

export type SessionTimelineCoverage = "complete" | "legacy_retained" | "incomplete";

export type SessionTimelinePage = {
  /** Authoritative durable-ledger generation; null means no ledger exists. */
  epoch: string | null;
  items: SessionTimelineItem[];
  /** Pass this cursor to fetch the immediately preceding (older) window. */
  previousCursor?: string;
  hasMore: boolean;
  coverage: SessionTimelineCoverage;
  /** True when another bounded compatibility-stream import pass is required. */
  legacyImportPending?: true;
  /** Present when the last authoritative append failed and history may be incomplete. */
  writeError?: string;
};

export type SessionTimelineQueuedTurn = {
  turnId: string;
  submittedAt: string;
  promptText?: string;
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
const timelineLockQueues = new Map<string, Promise<void>>();
const timelineLockQueueDepths = new Map<string, number>();

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

async function legacyCompatibilityFiles(record: SessionRecord): Promise<string[]> {
  const files: string[] = [];
  const maxSegments = Math.max(1, record.eventLog.max_segments);
  for (let segment = maxSegments; segment >= 1; segment -= 1) {
    const filePath = sessionEventSegmentPath(record.acpxRecordId, segment);
    if ((await fileSize(filePath)) > 0) {
      files.push(filePath);
    }
  }
  const activePath = sessionEventActivePath(record.acpxRecordId);
  if ((await fileSize(activePath)) > 0) {
    files.push(activePath);
  }
  return files;
}

type LegacyCompatibilitySource = {
  filePath: string;
  identity: string;
  size: number;
};

type LegacyCompatibilityMessage = {
  message: AcpJsonRpcMessage;
  endOffset: number;
};

type LegacySourceRead = {
  messages: LegacyCompatibilityMessage[];
  offset: number;
  bytesRead: number;
  discardingLine: boolean;
  trailingFragment: boolean;
};

async function legacyCompatibilitySources(
  record: SessionRecord,
): Promise<LegacyCompatibilitySource[]> {
  const result: LegacyCompatibilitySource[] = [];
  const identities = new Set<string>();
  for (const filePath of await legacyCompatibilityFiles(record)) {
    try {
      const stat = await fs.stat(filePath);
      const identity = `${String(stat.dev)}:${String(stat.ino)}`;
      if (!identities.has(identity)) {
        identities.add(identity);
        result.push({ filePath, identity, size: stat.size });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return result;
}

function parseLegacyCompatibilityLine(line: Buffer): AcpJsonRpcMessage | undefined {
  if (line.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line.toString("utf8")) as unknown;
    return isAcpJsonRpcMessage(parsed) ? parsed : undefined;
  } catch {
    // Compatibility streams historically tolerate corrupt lines. Their byte
    // cursor still advances so one malformed entry cannot stall every read.
    return undefined;
  }
}

function consumeLegacyLines(input: {
  data: Buffer;
  dataStart: number;
  messages: LegacyCompatibilityMessage[];
  messageBudget: number;
  discardingLine: boolean;
}): { consumedBytes: number; discardingLine: boolean } {
  let lineStart = 0;
  let discardingLine = input.discardingLine;
  for (let index = 0; index < input.data.length; index += 1) {
    if (input.data[index] !== 0x0a) {
      continue;
    }
    const endOffset = input.dataStart + index + 1;
    if (discardingLine) {
      discardingLine = false;
    } else {
      const parsed = parseLegacyCompatibilityLine(input.data.subarray(lineStart, index));
      if (parsed) {
        input.messages.push({ message: parsed, endOffset });
      }
    }
    lineStart = index + 1;
    if (input.messages.length >= input.messageBudget) {
      return { consumedBytes: lineStart, discardingLine };
    }
  }
  return { consumedBytes: lineStart, discardingLine };
}

// oxlint-disable-next-line eslint/complexity -- Bounded streaming distinguishes EOF, budget, and malformed-line progress.
async function readLegacySource(input: {
  source: LegacyCompatibilitySource;
  cursor: SessionTimelineLegacyImportSource;
  byteBudget: number;
  messageBudget: number;
}): Promise<LegacySourceRead> {
  const handle = await fs.open(input.source.filePath, "r");
  try {
    let position = Math.min(input.cursor.offset, input.source.size);
    let committedOffset = position;
    let carry = Buffer.alloc(0);
    let carryStart = position;
    let bytesReadTotal = 0;
    let discardingLine = input.cursor.discarding_line === true;
    const messages: LegacyCompatibilityMessage[] = [];
    while (
      position < input.source.size &&
      bytesReadTotal < input.byteBudget &&
      messages.length < input.messageBudget
    ) {
      const bytesToRead = Math.min(
        LEGACY_READ_CHUNK_BYTES,
        input.source.size - position,
        input.byteBudget - bytesReadTotal,
      );
      if (bytesToRead <= 0) {
        break;
      }
      const chunk = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(chunk, 0, bytesToRead, position);
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      bytesReadTotal += bytesRead;
      const data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      const consumed = consumeLegacyLines({
        data,
        dataStart: carryStart,
        messages,
        messageBudget: input.messageBudget,
        discardingLine,
      });
      discardingLine = consumed.discardingLine;
      committedOffset = carryStart + consumed.consumedBytes;
      carry = Buffer.from(data.subarray(consumed.consumedBytes));
      carryStart = committedOffset;
    }
    if (committedOffset === input.cursor.offset && bytesReadTotal >= input.byteBudget) {
      // An entry larger than the per-read budget is malformed for the retained
      // compatibility surface. Advance in bounded chunks and discard through
      // its newline on later calls instead of allocating it or stalling.
      committedOffset = position;
      discardingLine = true;
    }
    return {
      messages,
      offset: committedOffset,
      bytesRead: bytesReadTotal,
      discardingLine,
      trailingFragment:
        position === input.source.size && carry.length > 0 && messages.length < input.messageBudget,
    };
  } finally {
    await handle.close();
  }
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
    // Timeline locks cover one append/checkpoint critical section. Filesystem
    // I/O can still pause indefinitely, so a live owner remains authoritative
    // regardless of the lock's age.
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

/**
 * Serialize every timeline mutation for one session in-process and across
 * processes. The local FIFO also makes prune/read ordering deterministic while
 * the filesystem lock remains the authority between independent acpx builds.
 */
export async function withSessionTimelineLock<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  timelineLockQueueDepths.set(sessionId, (timelineLockQueueDepths.get(sessionId) ?? 0) + 1);
  const previous = timelineLockQueues.get(sessionId) ?? Promise.resolve();
  let releaseLocal!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  const tail = previous.then(() => current);
  timelineLockQueues.set(sessionId, tail);
  await previous;
  let lock: TimelineLock | undefined;
  try {
    lock = await acquireTimelineLock(sessionId);
    return await operation();
  } finally {
    if (lock) {
      await releaseTimelineLock(lock);
    }
    releaseLocal();
    if (timelineLockQueues.get(sessionId) === tail) {
      timelineLockQueues.delete(sessionId);
    }
    const depth = (timelineLockQueueDepths.get(sessionId) ?? 1) - 1;
    if (depth === 0) {
      timelineLockQueueDepths.delete(sessionId);
    } else {
      timelineLockQueueDepths.set(sessionId, depth);
    }
  }
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
  turn_submitted: (record) => isOptionalString(record.prompt_text),
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
    acp: () =>
      isAcpJsonRpcMessage(payload.message) &&
      (payload.legacy_cursor === undefined || isLegacyCursor(payload.legacy_cursor)),
    lifecycle: () => isLifecycleEvent(payload.event),
  };
  return typeof payload.kind === "string" && (validators[payload.kind]?.() ?? false);
}

function isLegacyCursor(value: unknown): value is SessionTimelineLegacyCursor {
  const cursor = asRecord(value);
  return Boolean(
    cursor && typeof cursor.source_identity === "string" && isPositiveInteger(cursor.end_offset),
  );
}

export function parseSessionTimelineEvent(value: unknown): SessionTimelineEvent | undefined {
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

async function checkpointTimelineMetadata(
  record: SessionRecord,
  metadata: SessionTimelineMetadata,
): Promise<void> {
  const latest = await resolveSessionRecord(record.acpxRecordId);
  latest.timeline = metadata;
  await writeSessionRecord(latest);
  record.timeline = metadata;
}

function legacyCursorFromLatestEvent(
  event: SessionTimelineEvent | undefined,
): SessionTimelineLegacyCursor | undefined {
  return event?.payload.kind === "acp" ? event.payload.legacy_cursor : undefined;
}

function mergeCrashSafeLegacyCursor(
  metadata: SessionTimelineMetadata,
  latestEvent: SessionTimelineEvent | undefined,
): void {
  const latest = legacyCursorFromLatestEvent(latestEvent);
  if (!latest) {
    return;
  }
  const sources = metadata.legacy_import_sources ?? [];
  const current = sources.find((source) => source.source_identity === latest.source_identity);
  if (current) {
    current.offset = Math.max(current.offset, latest.end_offset);
    current.discarding_line = false;
  } else {
    sources.push({ source_identity: latest.source_identity, offset: latest.end_offset });
  }
  metadata.legacy_import_sources = sources;
}

async function initializeMetadata(record: SessionRecord): Promise<SessionTimelineMetadata> {
  const persisted = await resolveSessionRecord(record.acpxRecordId);
  if (persisted.timeline) {
    // Disk is authoritative across writers. A caller may retain a record from
    // before another writer isolated a corrupt epoch; trusting that stale
    // object here would resurrect the abandoned epoch and hide newer events.
    record.timeline = persisted.timeline;
    return record.timeline;
  }
  const createdAt = isoNow();
  const epoch = randomUUID();
  const retainedFiles = await legacyCompatibilityFiles(persisted);
  const legacyRetained = retainedFiles.length > 0 || (await sessionHasLegacyEvents(persisted));
  const metadata: SessionTimelineMetadata = {
    schema: SESSION_TIMELINE_SCHEMA,
    epoch,
    last_seq: 0,
    active_path: timelinePath(record.acpxRecordId, epoch),
    created_at: createdAt,
    last_write_error: null,
    legacy_retained: legacyRetained,
    legacy_import_complete: !legacyRetained,
    legacy_import_sources: [],
  };
  record.timeline = metadata;
  // The epoch must be discoverable before its first append. A process crash
  // after append but before close must not strand an orphan timeline file and
  // cause the next writer to create another epoch.
  await checkpointTimelineMetadata(record, metadata);
  return metadata;
}

async function reconcileTimelineMetadata(
  record: SessionRecord,
  metadata: SessionTimelineMetadata,
): Promise<SessionTimelineMetadata> {
  let corrupt = false;
  const [latest] = await readTimelineEventsBackward(record.acpxRecordId, metadata, {
    limit: 1,
    onCorrupt: () => {
      corrupt = true;
    },
  });
  const latestSeq = latest?.seq ?? 0;
  if (corrupt || metadata.last_seq > latestSeq) {
    metadata.epoch = randomUUID();
    metadata.last_seq = 0;
    metadata.active_path = timelinePath(record.acpxRecordId, metadata.epoch);
    metadata.created_at = isoNow();
    metadata.history_incomplete = true;
    // Make the replacement epoch discoverable before its first append. This
    // is the same crash boundary protected by initializeMetadata.
    await checkpointTimelineMetadata(record, metadata);
  } else {
    // The file is authoritative when a process died after append but before
    // checkpointing its session record.
    metadata.last_seq = latestSeq;
    mergeCrashSafeLegacyCursor(metadata, latest);
  }
  record.timeline = metadata;
  return metadata;
}

function mergeLocalTimelineAnnotations(
  latest: SessionTimelineMetadata,
  local: SessionTimelineMetadata | undefined,
): SessionTimelineMetadata {
  if (!local || latest.epoch !== local.epoch) {
    return latest;
  }
  latest.legacy_retained = local.legacy_retained;
  latest.legacy_import_complete = local.legacy_import_complete;
  latest.legacy_import_sources = local.legacy_import_sources;
  latest.history_incomplete =
    latest.history_incomplete === true || local.history_incomplete === true;
  if (local.last_write_error != null) {
    latest.last_write_error = local.last_write_error;
  }
  return latest;
}

/**
 * Persist non-timeline session state without overwriting a timeline append
 * that another writer committed while this caller held a long-lived record.
 */
export async function writeSessionRecordWithLatestTimeline(record: SessionRecord): Promise<void> {
  await withSessionTimelineLock(record.acpxRecordId, async () => {
    const localMetadata = record.timeline;
    const persisted = await resolveSessionRecord(record.acpxRecordId).catch(() => undefined);
    if (!localMetadata && !persisted?.timeline) {
      // Mode/config changes before the first prompt should not manufacture an
      // empty timeline merely because they use the concurrency-safe writer.
      await writeSessionRecord(record);
      return;
    }
    const metadata = mergeLocalTimelineAnnotations(
      await reconcileTimelineMetadata(record, await initializeMetadata(record)),
      localMetadata,
    );
    record.timeline = metadata;
    await writeSessionRecord(record);
  });
}

export class SessionTimelineWriter {
  private readonly record: SessionRecord;
  private metadata: SessionTimelineMetadata;
  private closed = false;

  private constructor(record: SessionRecord, metadata: SessionTimelineMetadata) {
    this.record = record;
    this.metadata = metadata;
  }

  static async open(record: SessionRecord): Promise<SessionTimelineWriter> {
    return await withSessionTimelineLock(record.acpxRecordId, async () => {
      const writer = await SessionTimelineWriter.openWhileLocked(record);
      if (writer.metadata.legacy_import_complete !== true) {
        while (await writer.importLegacyCompatibilityMessagesBounded()) {
          // A mutating writer preserves chronological activation semantics by
          // finishing retained history before it appends a new live event.
          // Once caught up, later compatibility bytes from this same modern
          // writer already have authoritative timeline twins and must not be
          // imported again. Read paths force a scan only while a live lease
          // explicitly identifies a pre-timeline owner.
        }
      }
      await checkpointTimelineMetadata(record, writer.metadata);
      return writer;
    });
  }

  private static async openWhileLocked(record: SessionRecord): Promise<SessionTimelineWriter> {
    const metadata = await reconcileTimelineMetadata(record, await initializeMetadata(record));
    return new SessionTimelineWriter(record, metadata);
  }

  static async refreshLegacyCompatibility(sessionId: string): Promise<boolean> {
    return await withSessionTimelineLock(sessionId, async () => {
      const record = await resolveSessionRecord(sessionId);
      const writer = await SessionTimelineWriter.openWhileLocked(record);
      const pending = await writer.importLegacyCompatibilityMessagesBounded();
      await checkpointTimelineMetadata(record, writer.metadata);
      return pending;
    });
  }

  getRecord(): SessionRecord {
    return this.record;
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
        payload: { kind: "acp", message: event.message, source: event.source },
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

  recordWriteError(error: unknown): void {
    this.metadata.last_write_error = error instanceof Error ? error.message : String(error);
  }

  // oxlint-disable-next-line eslint/complexity -- Rotation, truncation, and two independent budgets are explicit states.
  private async importLegacyCompatibilityMessagesBounded(): Promise<boolean> {
    const sources = await legacyCompatibilitySources(this.record);
    if (sources.length === 0) {
      this.metadata.legacy_import_complete = true;
      this.metadata.legacy_import_sources ??= [];
      return false;
    }
    this.metadata.legacy_retained = true;
    const cursors = this.metadata.legacy_import_sources ?? [];
    this.metadata.legacy_import_sources = cursors;
    const activeIdentities = new Set(sources.map((source) => source.identity));
    for (let index = cursors.length - 1; index >= 0; index -= 1) {
      if (!activeIdentities.has(cursors[index]?.source_identity ?? "")) {
        cursors.splice(index, 1);
      }
    }
    let bytesRemaining = LEGACY_IMPORT_MAX_BYTES_PER_READ;
    let messagesRemaining = LEGACY_IMPORT_MAX_MESSAGES_PER_READ;
    for (const source of sources) {
      if (bytesRemaining <= 0 || messagesRemaining <= 0) {
        break;
      }
      let cursor = cursors.find((entry) => entry.source_identity === source.identity);
      if (!cursor) {
        cursor = { source_identity: source.identity, offset: 0 };
        cursors.push(cursor);
      } else if (source.size < cursor.offset) {
        cursor.offset = 0;
        cursor.discarding_line = false;
        cursor.trailing_fragment = false;
      }
      if (cursor.offset >= source.size && cursor.discarding_line !== true) {
        continue;
      }
      const read = await readLegacySource({
        source,
        cursor,
        byteBudget: bytesRemaining,
        messageBudget: messagesRemaining,
      });
      bytesRemaining -= read.bytesRead;
      for (const imported of read.messages) {
        await this.appendWithoutLock({
          direction: "internal",
          capturedAt: this.metadata.created_at,
          requestId: requestIdFromMessage(imported.message),
          payload: {
            kind: "acp",
            message: imported.message,
            source: "legacy_stream",
            legacy_cursor: {
              source_identity: source.identity,
              end_offset: imported.endOffset,
            },
          },
        });
        cursor.offset = imported.endOffset;
        cursor.discarding_line = false;
        messagesRemaining -= 1;
      }
      cursor.offset = Math.max(cursor.offset, read.offset);
      cursor.discarding_line = read.discardingLine || undefined;
      cursor.trailing_fragment = read.trailingFragment || undefined;
      // Every imported event carries its source end offset. If the process
      // exits before this batched checkpoint, reconcile recovers the newest
      // committed cursor from the append-only timeline.
      await checkpointTimelineMetadata(this.record, this.metadata);
    }
    const latestSources = await legacyCompatibilitySources(this.record);
    const pending = latestSources.some((source) => {
      const cursor = cursors.find((entry) => entry.source_identity === source.identity);
      return (
        !cursor ||
        (cursor.offset < source.size && cursor.trailing_fragment !== true) ||
        (cursor.discarding_line === true && cursor.trailing_fragment !== true)
      );
    });
    this.metadata.legacy_import_complete = !pending;
    return pending;
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
    await withSessionTimelineLock(this.record.acpxRecordId, async () => {
      this.metadata = await reconcileTimelineMetadata(
        this.record,
        await initializeMetadata(this.record),
      );
      await this.appendWithoutLock(input);
      try {
        await checkpointTimelineMetadata(this.record, this.metadata);
      } catch (error) {
        // The envelope is already authoritative in the append-only file. Keep
        // the checkpoint fault visible, but do not make callers retry and
        // duplicate an event that was durably committed.
        this.recordWriteError(error);
      }
    });
  }

  private async appendWithoutLock(input: {
    direction: SessionTimelineDirection;
    capturedAt: string;
    turnId?: string;
    requestId?: string;
    payload: SessionTimelinePayload;
  }): Promise<void> {
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
    try {
      await fs.mkdir(path.dirname(this.metadata.active_path), { recursive: true });
      await fs.appendFile(this.metadata.active_path, `${JSON.stringify(envelope)}\n`, "utf8");
      this.metadata.last_seq = envelope.seq;
      this.metadata.last_write_at = isoNow();
      this.metadata.last_write_error = null;
    } catch (error) {
      this.recordWriteError(error);
      throw error;
    }
  }

  async close(options: { checkpoint?: boolean } = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (options.checkpoint !== true) {
      return;
    }

    const localMetadata = this.metadata;
    await withSessionTimelineLock(this.record.acpxRecordId, async () => {
      const latest = await reconcileTimelineMetadata(
        this.record,
        await initializeMetadata(this.record),
      );
      this.metadata = mergeLocalTimelineAnnotations(latest, localMetadata);
      await checkpointTimelineMetadata(this.record, this.metadata);
    });
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
  onCorrupt?: () => void;
};

// oxlint-disable-next-line eslint/complexity -- Corruption and filtering are deliberately distinguished for coverage reporting.
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
    const event = parseSessionTimelineEvent(JSON.parse(line.toString("utf8")) as unknown);
    if (!event || event.acpx_record_id !== sessionId || event.epoch !== metadata.epoch) {
      options.onCorrupt?.();
      return undefined;
    }
    if (!timelineEventMatches(event, sessionId, metadata, options)) {
      return undefined;
    }
    return event;
  } catch {
    options.onCorrupt?.();
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
    epoch: null,
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

function timelineCoverage(
  metadata: SessionTimelineMetadata,
  observedCorrupt = false,
): SessionTimelineCoverage {
  if (metadata.history_incomplete === true || observedCorrupt) {
    return "incomplete";
  }
  return metadata.legacy_retained ? "legacy_retained" : "complete";
}

function timelinePageItems(
  record: SessionRecord,
  metadata: SessionTimelineMetadata,
  hasMore: boolean,
  selected: SessionTimelineEvent[],
  observedCorrupt: boolean,
): SessionTimelineItem[] {
  const prefix = !hasMore ? historyGaps(record, observedCorrupt) : [];
  return [...prefix, ...selected];
}

function pageFromEvents(params: {
  record: SessionRecord;
  metadata: SessionTimelineMetadata;
  newestFirstEvents: SessionTimelineEvent[];
  limit: number;
  observedCorrupt?: boolean;
}): SessionTimelinePage {
  const hasMore = params.newestFirstEvents.length > params.limit;
  const selected = params.newestFirstEvents.slice(0, params.limit).toReversed();
  const first = selected[0];
  return {
    epoch: params.metadata.epoch,
    items: timelinePageItems(
      params.record,
      params.metadata,
      hasMore,
      selected,
      params.observedCorrupt === true,
    ),
    previousCursor:
      hasMore && first
        ? encodeCursor(params.record.acpxRecordId, params.metadata.epoch, first.seq)
        : undefined,
    hasMore,
    coverage: timelineCoverage(params.metadata, params.observedCorrupt),
    writeError: params.metadata.last_write_error ?? undefined,
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
  let observedCorrupt = false;
  const events = await readTimelineEventsBackward(record.acpxRecordId, metadata, {
    beforeSeq: cursor?.seq,
    limit: limit + 1,
    onCorrupt: () => {
      observedCorrupt = true;
    },
  });
  return pageFromEvents({
    record,
    metadata,
    newestFirstEvents: events,
    limit,
    observedCorrupt,
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

const QUEUED_TURN_RESOLVING_LIFECYCLES = new Set<SessionTimelineLifecycleEvent["type"]>([
  "turn_started",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "turn_interrupted",
]);

function queuedTurnLifecycleState(
  event: SessionTimelineEvent,
): "submitted" | "resolved" | "ignore" {
  if (event.payload.kind !== "lifecycle" || !event.turn_id) {
    return "ignore";
  }
  if (event.payload.event.type === "turn_submitted") {
    return "submitted";
  }
  return QUEUED_TURN_RESOLVING_LIFECYCLES.has(event.payload.event.type) ? "resolved" : "ignore";
}

function queuedTurnPredicate(resolved: Set<string>): (event: SessionTimelineEvent) => boolean {
  return (event) => {
    const turnId = event.turn_id;
    if (!turnId) {
      return false;
    }
    const state = queuedTurnLifecycleState(event);
    if (state === "resolved") {
      resolved.add(turnId);
      return false;
    }
    return state === "submitted" && !resolved.has(turnId);
  };
}

function projectQueuedTurn(event: SessionTimelineEvent): SessionTimelineQueuedTurn | undefined {
  if (
    !event.turn_id ||
    event.payload.kind !== "lifecycle" ||
    event.payload.event.type !== "turn_submitted"
  ) {
    return undefined;
  }
  return {
    turnId: event.turn_id,
    submittedAt: event.captured_at,
    promptText: event.payload.event.prompt_text,
  };
}

/**
 * Reconstruct submitted turns that have not durably started or terminated.
 *
 * This is intentionally timeline-derived rather than queue-process memory so a
 * browser or backend restart retains exact turn ids and display text. Older
 * envelopes without `prompt_text` remain valid and receive no invented text.
 */
export async function listQueuedSessionTimelineTurns(
  sessionId: string,
  maximum = Number.POSITIVE_INFINITY,
): Promise<SessionTimelineQueuedTurn[]> {
  const record = await resolveSessionRecord(sessionId);
  const metadata = record.timeline;
  const limit = Math.min(metadata?.last_seq ?? 0, Math.max(0, Math.trunc(maximum)));
  if (!metadata || limit === 0) {
    return [];
  }
  const resolved = new Set<string>();
  const lifecycle = await readTimelineEventsBackward(record.acpxRecordId, metadata, {
    limit,
    predicate: queuedTurnPredicate(resolved),
  });
  return lifecycle
    .flatMap((event) => {
      const queued = projectQueuedTurn(event);
      return queued ? [queued] : [];
    })
    .toReversed();
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
            "Retained pre-timeline messages were imported with activation-time timestamps and internal direction; older rotated or malformed history and its original provenance may be missing.",
        },
      ]
    : [];
}

function corruptGap(): SessionTimelineHistoryGap {
  return {
    schema: SESSION_TIMELINE_GAP_SCHEMA,
    kind: "history_gap",
    reason: "corrupt",
    message:
      "The authoritative timeline was corrupt or truncated; retained events remain available, but this history is incomplete.",
  };
}

function historyGaps(record: SessionRecord, observedCorrupt = false): SessionTimelineHistoryGap[] {
  return [
    ...(record.timeline?.history_incomplete === true || observedCorrupt ? [corruptGap()] : []),
    ...(record.timeline?.legacy_retained === true ? legacyGap(record) : []),
  ];
}

/** Delete timeline data while the caller holds `withSessionTimelineLock`. */
export async function deleteSessionTimelineWhileLocked(sessionId: string): Promise<number> {
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
    if (!name.startsWith(prefix) || !name.endsWith(".ndjson")) {
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

export const sessionTimelineTestInternals = {
  removeStaleLock,
  readTimelineEventsBackward,
  timelineLockQueueDepth: (sessionId: string): number =>
    timelineLockQueueDepths.get(sessionId) ?? 0,
};
