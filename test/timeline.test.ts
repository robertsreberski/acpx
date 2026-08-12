import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { defaultSessionEventLog } from "../src/session/event-log.js";
import {
  SessionEventWriter,
  listSessionEvents,
  sessionEventTestInternals,
} from "../src/session/events.js";
import {
  pruneSessions,
  resolveSessionRecord,
  writeSessionRecord,
} from "../src/session/persistence.js";
import {
  captureAcpTimelineEvent,
  getActiveSessionTimelineTurn,
  getLatestSessionTimelineLifecycleEvent,
  listSessionTimelinePage,
  SessionTimelineCursorError,
  sessionTimelineTestInternals,
} from "../src/session/timeline.js";
import type { AcpJsonRpcMessage, SessionRecord } from "../src/types.js";

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-timeline-home-"));
  const previous = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    await run(homeDir);
  } finally {
    if (previous === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previous;
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function sessionRecord(sessionId: string, cwd: string): SessionRecord {
  const now = "2026-08-12T10:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: sessionId,
    acpSessionId: `acp-${sessionId}`,
    agentCommand: AGENT_REGISTRY.codex,
    cwd,
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    eventLog: { ...defaultSessionEventLog(sessionId), segment_count: 1 },
    closed: false,
    title: null,
    messages: [],
    updated_at: now,
    cumulative_token_usage: {},
    request_token_usage: {},
    acpx: {},
  };
}

function updateMessage(sessionId: string, text: string): AcpJsonRpcMessage {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  } as never;
}

test("timeline preserves tap metadata while the compatibility stream stays raw", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-capture", cwd);
    await writeSessionRecord(record);
    const writer = await SessionEventWriter.open(record);
    const message = updateMessage(record.acpSessionId, "hello");
    const captured = captureAcpTimelineEvent("inbound", message, { turnId: "turn-1" });

    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await writer.appendCapturedMessages([captured]);
    await writer.appendLifecycleEvent(
      { type: "turn_completed", stop_reason: "end_turn" },
      { turnId: "turn-1", requestId: "admission-1" },
    );
    await writer.close({ checkpoint: true });

    const page = await listSessionTimelinePage(record.acpxRecordId);
    assert.equal(page.coverage, "complete");
    assert.equal(page.items.length, 2);
    const first = page.items[0];
    assert.ok(first && "payload" in first);
    assert.equal(first.captured_at, captured.capturedAt);
    assert.equal(first.direction, "inbound");
    assert.equal(first.turn_id, "turn-1");
    assert.deepEqual(first.payload, { kind: "acp", message });
    assert.equal(page.items[1] && "payload" in page.items[1] ? page.items[1].seq : 0, 2);

    assert.deepEqual(await listSessionEvents(record.acpxRecordId), [message]);
    const stored = await resolveSessionRecord(record.acpxRecordId);
    assert.equal(stored.timeline?.schema, "acpx.session_timeline.v1");
    assert.equal(stored.timeline?.last_seq, 2);
    assert.equal(stored.timeline?.legacy_retained, false);
    assert.match(stored.timeline?.active_path ?? "", /\.timeline\.[^.]+\.ndjson$/);

    const latestLifecycle = await getLatestSessionTimelineLifecycleEvent(record.acpxRecordId);
    assert.deepEqual(latestLifecycle?.payload, {
      kind: "lifecycle",
      event: { type: "turn_completed", stop_reason: "end_turn" },
    });
  });
});

test("authoritative timeline append precedes the bounded compatibility stream", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-authoritative-first", cwd);
    await writeSessionRecord(record);
    const writer = await SessionEventWriter.open(record, {
      afterTimelineAppend: () => {
        throw new Error("compatibility stream unavailable");
      },
    });
    const message = updateMessage(record.acpSessionId, "survives");
    await writer.appendMessage(message);
    await writer.close({ checkpoint: true });

    const page = await listSessionTimelinePage(record.acpxRecordId);
    assert.equal(page.items.length, 1);
    assert.deepEqual("payload" in page.items[0] ? page.items[0].payload : undefined, {
      kind: "acp",
      message,
    });
    assert.deepEqual(await listSessionEvents(record.acpxRecordId), []);
    assert.equal(
      (await resolveSessionRecord(record.acpxRecordId)).eventLog.last_write_error,
      "compatibility stream unavailable",
    );
  });
});

test("legacy retained sessions disclose a gap instead of claiming complete history", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-legacy", cwd);
    record.lastSeq = 3;
    record.eventLog.last_write_at = "2026-08-12T09:00:00.000Z";
    await writeSessionRecord(record);

    const beforeUpgrade = await listSessionTimelinePage(record.acpxRecordId);
    assert.equal(beforeUpgrade.coverage, "legacy_retained");
    assert.deepEqual(
      beforeUpgrade.items.map((item) => item.schema),
      ["acpx.session_history_gap.v1"],
    );

    const writer = await SessionEventWriter.open(record);
    await writer.appendMessage(updateMessage(record.acpSessionId, "new"));
    await writer.close({ checkpoint: true });

    const afterUpgrade = await listSessionTimelinePage(record.acpxRecordId);
    assert.equal(afterUpgrade.coverage, "legacy_retained");
    assert.equal(afterUpgrade.items[0]?.schema, "acpx.session_history_gap.v1");
    assert.equal(afterUpgrade.items[1]?.schema, "acpx.session_event.v1");
  });
});

test("opaque timeline cursors open at the latest window and page backward", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const firstRecord = sessionRecord("timeline-page-a", cwd);
    const secondRecord = sessionRecord("timeline-page-b", cwd);
    await writeSessionRecord(firstRecord);
    await writeSessionRecord(secondRecord);

    const writer = await SessionEventWriter.open(firstRecord);
    await writer.appendMessages([
      updateMessage(firstRecord.acpSessionId, "one"),
      updateMessage(firstRecord.acpSessionId, "two"),
      updateMessage(firstRecord.acpSessionId, "three"),
    ]);
    await writer.close({ checkpoint: true });

    const first = await listSessionTimelinePage(firstRecord.acpxRecordId, { limit: 2 });
    assert.equal(first.items.length, 2);
    assert.equal(first.hasMore, true);
    assert.ok(first.previousCursor);
    assert.doesNotMatch(first.previousCursor, /timeline-page-a/);
    assert.deepEqual(
      first.items.map((item) => ("payload" in item ? item.seq : 0)),
      [2, 3],
    );

    const second = await listSessionTimelinePage(firstRecord.acpxRecordId, {
      before: first.previousCursor,
      limit: 2,
    });
    assert.equal(second.items.length, 1);
    assert.equal(second.hasMore, false);
    assert.equal("payload" in second.items[0] ? second.items[0].seq : 0, 1);

    await assert.rejects(
      listSessionTimelinePage(secondRecord.acpxRecordId, { before: first.previousCursor }),
      (error: unknown) =>
        error instanceof SessionTimelineCursorError && error.code === "CURSOR_INVALID",
    );

    const stored = await resolveSessionRecord(firstRecord.acpxRecordId);
    assert.ok(stored.timeline);
    stored.timeline.epoch = "replacement-epoch";
    await writeSessionRecord(stored);
    await assert.rejects(
      listSessionTimelinePage(firstRecord.acpxRecordId, { before: first.previousCursor }),
      (error: unknown) =>
        error instanceof SessionTimelineCursorError &&
        error.code === "CURSOR_EXPIRED" &&
        typeof error.earliestCursor === "string",
    );
  });
});

test("latest and previous timeline windows use bounded reverse reads", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-bounded-reverse", cwd);
    await writeSessionRecord(record);
    const writer = await SessionEventWriter.open(record);
    const large = "x".repeat(40_000);
    for (let index = 1; index <= 40; index += 1) {
      await writer.appendMessage(updateMessage(record.acpSessionId, `${index}:${large}`));
    }
    await writer.close({ checkpoint: true });
    const stored = await resolveSessionRecord(record.acpxRecordId);
    assert.ok(stored.timeline);
    const totalBytes = (await fs.stat(stored.timeline.active_path)).size;
    let bytesRead = 0;
    const newest = await sessionTimelineTestInternals.readTimelineEventsBackward(
      stored.acpxRecordId,
      stored.timeline,
      {
        limit: 3,
        onBytesRead: (bytes) => {
          bytesRead += bytes;
        },
      },
    );
    assert.deepEqual(
      newest.map((event) => event.seq),
      [40, 39, 38],
    );
    assert.equal(bytesRead < totalBytes / 4, true);

    const firstPage = await listSessionTimelinePage(record.acpxRecordId, { limit: 2 });
    assert.deepEqual(
      firstPage.items.map((item) => ("payload" in item ? item.seq : 0)),
      [39, 40],
    );
    const previousPage = await listSessionTimelinePage(record.acpxRecordId, {
      before: firstPage.previousCursor,
      limit: 2,
    });
    assert.deepEqual(
      previousPage.items.map((item) => ("payload" in item ? item.seq : 0)),
      [37, 38],
    );
  });
});

test("active turn lookup ignores newer queued submissions", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-active-turn", cwd);
    await writeSessionRecord(record);
    const writer = await SessionEventWriter.open(record);
    await writer.appendLifecycleEvent({ type: "turn_submitted" }, { turnId: "turn-1" });
    await writer.appendLifecycleEvent({ type: "turn_started" }, { turnId: "turn-1" });
    await writer.appendLifecycleEvent({ type: "turn_submitted" }, { turnId: "turn-2" });
    await writer.close({ checkpoint: true });

    assert.equal((await getActiveSessionTimelineTurn(record.acpxRecordId))?.turn_id, "turn-1");

    const reopened = await SessionEventWriter.open(await resolveSessionRecord(record.acpxRecordId));
    await reopened.appendLifecycleEvent({ type: "turn_completed" }, { turnId: "turn-1" });
    await reopened.close({ checkpoint: true });
    assert.equal(await getActiveSessionTimelineTurn(record.acpxRecordId), undefined);
  });
});

test("timeline files survive close and are deleted only by history pruning", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-prune", cwd);
    record.closed = true;
    record.closedAt = "2026-08-12T10:01:00.000Z";
    await writeSessionRecord(record);

    const writer = await SessionEventWriter.open(record);
    await writer.appendMessage(updateMessage(record.acpSessionId, "kept"));
    await writer.close({ checkpoint: true });
    const activePath = writer.getRecord().timeline?.active_path;
    assert.ok(activePath);
    await fs.access(activePath);

    const result = await pruneSessions({ includeHistory: true });
    assert.deepEqual(
      result.pruned.map((entry) => entry.acpxRecordId),
      [record.acpxRecordId],
    );
    await assert.rejects(fs.access(activePath));
    assert.equal(result.bytesFreed > 0, true);
  });
});

test("live writer locks never become stale merely because a turn is old", async () => {
  await withTempHome(async (homeDir) => {
    const keeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    assert.ok(keeper.pid);
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    const payload = `${JSON.stringify({
      pid: keeper.pid,
      created_at: "2000-01-01T00:00:00.000Z",
    })}\n`;
    const timelineLock = path.join(sessionDir, "live.timeline.lock");
    const streamLock = path.join(sessionDir, "live.stream.lock");
    await fs.writeFile(timelineLock, payload);
    await fs.writeFile(streamLock, payload);

    try {
      assert.equal(await sessionTimelineTestInternals.removeStaleLock(timelineLock), false);
      assert.equal(await sessionEventTestInternals.removeStaleEventLock(streamLock), false);
      await fs.access(timelineLock);
      await fs.access(streamLock);
    } finally {
      keeper.kill("SIGTERM");
    }
  });
});
