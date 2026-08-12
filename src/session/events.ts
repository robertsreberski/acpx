import fs from "node:fs/promises";
import { isAcpJsonRpcMessage } from "../acp/jsonrpc.js";
import { incrementPerfCounter, measurePerf } from "../perf-metrics.js";
import { isProcessAlive } from "../process-liveness.js";
import type { AcpJsonRpcMessage, SessionRecord } from "../types.js";
import {
  DEFAULT_EVENT_MAX_SEGMENTS,
  DEFAULT_EVENT_SEGMENT_MAX_BYTES,
  sessionBaseDir,
  sessionEventActivePath as activeEventPath,
  sessionEventLockPath as eventsLockPath,
  sessionEventSegmentPath as segmentEventPath,
} from "./event-log.js";
import { resolveSessionRecord, writeSessionRecord } from "./persistence.js";
import {
  captureAcpTimelineEvent,
  type CapturedAcpTimelineEvent,
  type SessionTimelineLifecycleEvent,
  SessionTimelineWriter,
} from "./timeline.js";

const LOCK_RETRY_MS = 15;

async function ensureSessionDir(): Promise<void> {
  await fs.mkdir(sessionBaseDir(), { recursive: true });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function statSize(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}

async function countExistingSegments(sessionId: string, maxSegments: number): Promise<number> {
  let count = 0;

  for (let segment = 1; segment <= maxSegments; segment += 1) {
    if (await pathExists(segmentEventPath(sessionId, segment))) {
      count += 1;
    }
  }

  if (await pathExists(activeEventPath(sessionId))) {
    count += 1;
  }

  return count;
}

async function resolveInitialSegmentCount(
  record: SessionRecord,
  maxSegments: number,
): Promise<number> {
  if (Number.isInteger(record.eventLog.segment_count) && record.eventLog.segment_count > 0) {
    return record.eventLog.segment_count;
  }
  return (await countExistingSegments(record.acpxRecordId, maxSegments)) || 1;
}

async function resolveSessionMaxSegments(sessionId: string): Promise<number> {
  try {
    const record = await resolveSessionRecord(sessionId);
    const configured = record.eventLog.max_segments;
    if (Number.isInteger(configured) && configured > 0) {
      return configured;
    }
  } catch {
    // Fall back to defaults when metadata is unavailable.
  }

  return DEFAULT_EVENT_MAX_SEGMENTS;
}

async function rotateSegments(sessionId: string, maxSegments: number): Promise<void> {
  const active = activeEventPath(sessionId);

  const overflow = segmentEventPath(sessionId, maxSegments);
  await fs.unlink(overflow).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });

  for (let segment = maxSegments - 1; segment >= 1; segment -= 1) {
    const from = segmentEventPath(sessionId, segment);
    const to = segmentEventPath(sessionId, segment + 1);
    if (!(await pathExists(from))) {
      continue;
    }
    await fs.rename(from, to);
  }

  if (await pathExists(active)) {
    await fs.rename(active, segmentEventPath(sessionId, 1));
  }
}

type LockHandle = {
  filePath: string;
};

type EventLockPayload = {
  pid?: number;
  created_at?: string;
};

function lockOwnerIsAlive(pid: number | undefined): boolean {
  return pid === process.pid || isProcessAlive(pid);
}

function parseEventLockPayload(raw: string): EventLockPayload {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    return {
      pid: typeof record.pid === "number" ? record.pid : undefined,
      created_at: typeof record.created_at === "string" ? record.created_at : undefined,
    };
  } catch {
    return {};
  }
}

async function removeStaleEventLock(lockPath: string): Promise<boolean> {
  try {
    const payload = await fs.readFile(lockPath, "utf8");
    const parsed = parseEventLockPayload(payload);
    const pidAlive = lockOwnerIsAlive(parsed.pid);
    // A turn may legitimately hold this lock for hours while awaiting a human.
    // Age never makes a lock stale while its owning process is alive.
    if (pidAlive) {
      return false;
    }
    await fs.unlink(lockPath);
    incrementPerfCounter("session.events.stale_lock_recovered");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    return false;
  }
}

async function acquireEventsLock(sessionId: string): Promise<LockHandle> {
  await ensureSessionDir();
  const lockPath = eventsLockPath(sessionId);
  const payload = JSON.stringify(
    {
      pid: process.pid,
      created_at: new Date().toISOString(),
    },
    null,
    2,
  );

  for (;;) {
    try {
      await fs.writeFile(lockPath, `${payload}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return { filePath: lockPath };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      const recovered = await removeStaleEventLock(lockPath);
      if (recovered) {
        continue;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, LOCK_RETRY_MS);
      });
    }
  }
}

async function releaseEventsLock(lock: LockHandle): Promise<void> {
  await fs.unlink(lock.filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

type SessionEventWriterOptions = {
  maxSegmentBytes?: number;
  maxSegments?: number;
  /** Test-only fault injection after the authoritative timeline append. */
  afterTimelineAppend?: () => void | Promise<void>;
};

type AppendOptions = {
  checkpoint?: boolean;
};

export class SessionEventWriter {
  private readonly record: SessionRecord;
  private readonly lock: LockHandle;
  private readonly maxSegmentBytes: number;
  private readonly maxSegments: number;
  private readonly timelineWriter: SessionTimelineWriter;
  private readonly afterTimelineAppend?: () => void | Promise<void>;
  private activePath: string;
  private activeSizeBytes: number;
  private segmentCount: number;
  private closed = false;

  private constructor(
    record: SessionRecord,
    lock: LockHandle,
    options: Required<SessionEventWriterOptions>,
    timelineWriter: SessionTimelineWriter,
    state: {
      activePath: string;
      activeSizeBytes: number;
      segmentCount: number;
    },
  ) {
    this.record = record;
    this.lock = lock;
    this.maxSegmentBytes = options.maxSegmentBytes;
    this.maxSegments = options.maxSegments;
    this.timelineWriter = timelineWriter;
    this.afterTimelineAppend = options.afterTimelineAppend;
    this.activePath = state.activePath;
    this.activeSizeBytes = state.activeSizeBytes;
    this.segmentCount = state.segmentCount;
  }

  static async open(
    record: SessionRecord,
    options: SessionEventWriterOptions = {},
  ): Promise<SessionEventWriter> {
    const lock = await acquireEventsLock(record.acpxRecordId);
    try {
      const timelineWriter = await SessionTimelineWriter.open(record);
      const maxSegmentBytes =
        options.maxSegmentBytes ??
        record.eventLog.max_segment_bytes ??
        DEFAULT_EVENT_SEGMENT_MAX_BYTES;
      const maxSegments =
        options.maxSegments ?? record.eventLog.max_segments ?? DEFAULT_EVENT_MAX_SEGMENTS;
      const activePath = activeEventPath(record.acpxRecordId);
      const activeSizeBytes = await statSize(activePath);
      const segmentCount = await resolveInitialSegmentCount(record, maxSegments);
      return new SessionEventWriter(
        record,
        lock,
        {
          maxSegmentBytes,
          maxSegments,
          afterTimelineAppend: options.afterTimelineAppend ?? (() => {}),
        },
        timelineWriter,
        {
          activePath,
          activeSizeBytes,
          segmentCount,
        },
      );
    } catch (error) {
      await releaseEventsLock(lock);
      throw error;
    }
  }

  getRecord(): SessionRecord {
    return this.record;
  }

  async appendMessage(message: AcpJsonRpcMessage, options: AppendOptions = {}): Promise<void> {
    await this.appendMessages([message], options);
  }

  async appendMessages(messages: AcpJsonRpcMessage[], options: AppendOptions = {}): Promise<void> {
    const captured = messages.map((message) => captureAcpTimelineEvent("internal", message));
    await this.appendCapturedMessages(captured, options);
  }

  async appendCapturedMessages(
    captured: CapturedAcpTimelineEvent[],
    options: AppendOptions = {},
  ): Promise<void> {
    if (this.closed) {
      throw new Error("SessionEventWriter is closed");
    }

    if (captured.length === 0) {
      return;
    }

    await ensureSessionDir();

    await measurePerf("session.events.append_batch", async () => {
      for (const event of captured) {
        await this.appendCapturedMessage(event);
      }
    });

    if (options.checkpoint === true) {
      await writeSessionRecord(this.record);
    }
  }

  private async appendCapturedMessage(event: CapturedAcpTimelineEvent): Promise<void> {
    const message = event.message;
    if (!isAcpJsonRpcMessage(message)) {
      throw new Error("Attempted to persist invalid ACP JSON-RPC payload");
    }
    await this.timelineWriter.appendAcpEvents([event]);
    try {
      await this.afterTimelineAppend?.();
      const line = `${JSON.stringify(message)}\n`;
      await this.rotateCompatibilityStreamIfNeeded(Buffer.byteLength(line));
      await fs.appendFile(this.activePath, line, "utf8");
      this.activeSizeBytes += Buffer.byteLength(line);
      this.updateCompatibilityMetadata(message);
    } catch (error) {
      this.record.eventLog.last_write_error =
        error instanceof Error ? error.message : String(error);
    }
  }

  private async rotateCompatibilityStreamIfNeeded(lineBytes: number): Promise<void> {
    if (this.activeSizeBytes === 0 || this.activeSizeBytes + lineBytes <= this.maxSegmentBytes) {
      return;
    }
    await rotateSegments(this.record.acpxRecordId, this.maxSegments);
    this.activePath = activeEventPath(this.record.acpxRecordId);
    this.activeSizeBytes = 0;
    this.segmentCount = Math.min(this.segmentCount + 1, this.maxSegments);
    incrementPerfCounter("session.events.rotate");
  }

  private updateCompatibilityMetadata(message: AcpJsonRpcMessage): void {
    this.record.lastSeq += 1;
    if (Object.hasOwn(message, "id")) {
      const id = (message as { id?: unknown }).id;
      if (typeof id === "string" || typeof id === "number") {
        this.record.lastRequestId = String(id);
      }
    }
    const writeTs = new Date().toISOString();
    this.record.lastUsedAt = writeTs;
    this.record.eventLog = {
      active_path: this.activePath,
      segment_count: this.segmentCount,
      max_segment_bytes: this.maxSegmentBytes,
      max_segments: this.maxSegments,
      last_write_at: writeTs,
      last_write_error: null,
    };
  }

  async appendLifecycleEvent(
    event: SessionTimelineLifecycleEvent,
    association: { capturedAt?: string; turnId?: string; requestId?: string } = {},
  ): Promise<void> {
    if (this.closed) {
      throw new Error("SessionEventWriter is closed");
    }
    await this.timelineWriter.appendLifecycleEvent(event, association);
  }

  async checkpoint(): Promise<void> {
    if (this.closed) {
      throw new Error("SessionEventWriter is closed");
    }
    await writeSessionRecord(this.record);
  }

  async close(options: AppendOptions = {}): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      if (options.checkpoint !== false) {
        await writeSessionRecord(this.record);
      }
    } finally {
      this.closed = true;
      try {
        await this.timelineWriter.close();
      } finally {
        await releaseEventsLock(this.lock);
      }
    }
  }
}

export async function listSessionEvents(sessionId: string): Promise<AcpJsonRpcMessage[]> {
  const maxSegments = await resolveSessionMaxSegments(sessionId);
  const files: string[] = [];

  for (let segment = maxSegments; segment >= 1; segment -= 1) {
    const filePath = segmentEventPath(sessionId, segment);
    if (await pathExists(filePath)) {
      files.push(filePath);
    }
  }

  const active = activeEventPath(sessionId);
  if (await pathExists(active)) {
    files.push(active);
  }

  const events: AcpJsonRpcMessage[] = [];
  for (const filePath of files) {
    const payload = await fs.readFile(filePath, "utf8");
    const lines = payload.split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isAcpJsonRpcMessage(parsed)) {
          events.push(parsed);
        }
      } catch {
        // Skip malformed lines to keep event listing resilient.
      }
    }
  }

  return events;
}

export const sessionEventTestInternals = { removeStaleEventLock };
