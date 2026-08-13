import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { sessionRuntimeTestInternals } from "../src/cli/session/runtime.js";
import { defaultSessionEventLog } from "../src/session/event-log.js";
import { sessionEventActivePath, sessionEventSegmentPath } from "../src/session/event-log.js";
import {
  SessionEventAppendError,
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
  appendSessionTimelineLifecycleEvent,
  captureAcpTimelineEvent,
  getActiveSessionTimelineTurn,
  getLatestSessionTimelineLifecycleEvent,
  listQueuedSessionTimelineTurns,
  listSessionTimelinePage,
  SESSION_TIMELINE_MAX_EVENT_BYTES,
  SESSION_TIMELINE_MAX_PAGE_BYTES,
  SessionTimelineCursorError,
  SessionTimelineWriter,
  sessionTimelineTestInternals,
  withSessionTimelineLock,
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

test("reopening a modern event writer never imports its compatibility copy", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-modern-reopen", cwd);
    await writeSessionRecord(record);

    const first = await SessionEventWriter.open(record);
    await first.appendMessage(updateMessage(record.acpSessionId, "one"));
    await first.close({ checkpoint: true });

    const second = await SessionEventWriter.open(await resolveSessionRecord(record.acpxRecordId));
    await second.appendMessage(updateMessage(record.acpSessionId, "two"));
    await second.close({ checkpoint: true });

    const page = await listSessionTimelinePage(record.acpxRecordId, { limit: 20 });
    assert.deepEqual(
      page.items.flatMap((item) =>
        "payload" in item && item.payload.kind === "acp" ? [item.payload.message] : [],
      ),
      [updateMessage(record.acpSessionId, "one"), updateMessage(record.acpSessionId, "two")],
    );
  });
});

test("partial timeline failure acknowledges committed events before a retry", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-partial-retry", cwd);
    await writeSessionRecord(record);
    let attempts = 0;
    let failed = false;
    const writer = await SessionEventWriter.open(record, {
      beforeTimelineAppend: () => {
        attempts += 1;
        if (!failed && attempts === 3) {
          failed = true;
          throw new Error("timeline disk fault");
        }
      },
    });
    const messages = ["one", "two", "three"].map((text) =>
      updateMessage(record.acpSessionId, text),
    );
    const pendingMessages = [...messages];
    const pendingTimelineEvents = messages.map((message) =>
      captureAcpTimelineEvent("inbound", message, { turnId: "turn-1" }),
    );
    const flush = sessionRuntimeTestInternals.createCapturedMessageQueueFlusher({
      eventWriter: writer,
      pendingMessages,
      pendingTimelineEvents,
    });

    await assert.rejects(
      flush(),
      (error: unknown) =>
        error instanceof SessionEventAppendError &&
        error.committedCount === 2 &&
        error.message === "timeline disk fault",
    );
    assert.equal(pendingMessages.length, 1);
    assert.equal(pendingTimelineEvents.length, 1);

    await flush(true);
    await writer.close({ checkpoint: true });

    const page = await listSessionTimelinePage(record.acpxRecordId);
    const timelineMessages = page.items.flatMap((item) =>
      "payload" in item && item.payload.kind === "acp" ? [item.payload.message] : [],
    );
    assert.deepEqual(timelineMessages, messages);
    assert.deepEqual(
      page.items.flatMap((item) => ("payload" in item ? [item.seq] : [])),
      [1, 2, 3],
    );
    assert.equal(page.writeError, undefined);
  });
});

test("concurrent captured-message flushes append each event once and drain late additions", async () => {
  const messages = ["one", "two", "three"].map((text) => updateMessage("acp-overlap", text));
  const pendingMessages = messages.slice(0, 2);
  const pendingTimelineEvents = pendingMessages.map((message) =>
    captureAcpTimelineEvent("inbound", message, { turnId: "turn-overlap" }),
  );
  const appendedBatches: AcpJsonRpcMessage[][] = [];
  let markFirstAppendStarted: (() => void) | undefined;
  const firstAppendStarted = new Promise<void>((resolve) => {
    markFirstAppendStarted = resolve;
  });
  let releaseFirstAppend: (() => void) | undefined;
  const firstAppendBlocked = new Promise<void>((resolve) => {
    releaseFirstAppend = resolve;
  });
  const eventWriter: Pick<SessionEventWriter, "appendCapturedMessages"> = {
    appendCapturedMessages: async (captured) => {
      appendedBatches.push(captured.map((event) => event.message));
      if (appendedBatches.length === 1) {
        markFirstAppendStarted?.();
        await firstAppendBlocked;
      }
      return captured.length;
    },
  };
  const flush = sessionRuntimeTestInternals.createCapturedMessageQueueFlusher({
    eventWriter,
    pendingMessages,
    pendingTimelineEvents,
  });

  const firstFlush = flush();
  await firstAppendStarted;
  const secondFlush = flush();
  pendingMessages.push(messages[2]);
  pendingTimelineEvents.push(
    captureAcpTimelineEvent("inbound", messages[2], { turnId: "turn-overlap" }),
  );

  await Promise.resolve();
  assert.equal(appendedBatches.length, 1);
  releaseFirstAppend?.();
  await Promise.all([firstFlush, secondFlush]);

  assert.deepEqual(appendedBatches, [messages.slice(0, 2), messages.slice(2)]);
  assert.deepEqual(pendingMessages, []);
  assert.deepEqual(pendingTimelineEvents, []);
});

test("a queued captured-message flush retries the uncommitted suffix after failure", async () => {
  const messages = ["one", "two", "three"].map((text) => updateMessage("acp-retry", text));
  const pendingMessages = [...messages];
  const pendingTimelineEvents = messages.map((message) =>
    captureAcpTimelineEvent("inbound", message, { turnId: "turn-retry" }),
  );
  const appendedBatches: AcpJsonRpcMessage[][] = [];
  let markFirstAppendStarted: (() => void) | undefined;
  const firstAppendStarted = new Promise<void>((resolve) => {
    markFirstAppendStarted = resolve;
  });
  let releaseFirstAppend: (() => void) | undefined;
  const firstAppendBlocked = new Promise<void>((resolve) => {
    releaseFirstAppend = resolve;
  });
  const eventWriter: Pick<SessionEventWriter, "appendCapturedMessages"> = {
    appendCapturedMessages: async (captured) => {
      appendedBatches.push(captured.map((event) => event.message));
      if (appendedBatches.length === 1) {
        markFirstAppendStarted?.();
        await firstAppendBlocked;
        throw new SessionEventAppendError(new Error("timeline disk fault"), 1);
      }
      return captured.length;
    },
  };
  const flush = sessionRuntimeTestInternals.createCapturedMessageQueueFlusher({
    eventWriter,
    pendingMessages,
    pendingTimelineEvents,
  });

  const failedFlush = flush();
  await firstAppendStarted;
  const retryFlush = flush();
  releaseFirstAppend?.();

  await assert.rejects(
    failedFlush,
    (error: unknown) =>
      error instanceof SessionEventAppendError &&
      error.committedCount === 1 &&
      error.message === "timeline disk fault",
  );
  await retryFlush;

  assert.deepEqual(appendedBatches, [messages, messages.slice(1)]);
  assert.deepEqual(pendingMessages, []);
  assert.deepEqual(pendingTimelineEvents, []);
});

test("an authoritative append failure remains visible after cleanup checkpoints", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-write-error", cwd);
    await writeSessionRecord(record);
    const writer = await SessionEventWriter.open(record, {
      beforeTimelineAppend: () => {
        throw new Error("timeline volume is read-only");
      },
    });
    await assert.rejects(writer.appendMessage(updateMessage(record.acpSessionId, "lost")));
    await writer.close({ checkpoint: true });

    const page = await listSessionTimelinePage(record.acpxRecordId);
    assert.equal(page.writeError, "timeline volume is read-only");
    assert.deepEqual(page.items, []);
  });
});

test("timeline metadata survives a crash boundary before writer close", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-crash-metadata", cwd);
    await writeSessionRecord(record);
    const writer = await SessionTimelineWriter.open(record);
    const epoch = writer.getRecord().timeline?.epoch;
    assert.ok(epoch);
    const first = updateMessage(record.acpSessionId, "before crash");
    await writer.appendAcpEvents([captureAcpTimelineEvent("inbound", first)]);

    // Simulate a process dying before its final metadata checkpoint: reload
    // from disk while the writer is still open. The epoch was persisted before
    // the append, so readers can already discover the event.
    const reloaded = await resolveSessionRecord(record.acpxRecordId);
    assert.equal(reloaded.timeline?.epoch, epoch);
    assert.deepEqual(
      (await listSessionTimelinePage(record.acpxRecordId)).items.flatMap((item) =>
        "payload" in item && item.payload.kind === "acp" ? [item.payload.message] : [],
      ),
      [first],
    );

    // A real crash releases the OS/process ownership. Close without a
    // checkpoint solely to release the in-process test lock, then prove the
    // next writer recovers last_seq from the file and keeps the same epoch.
    await writer.close({ checkpoint: false });
    const reopened = await SessionTimelineWriter.open(reloaded);
    await reopened.appendAcpEvents([
      captureAcpTimelineEvent("inbound", updateMessage(record.acpSessionId, "after crash")),
    ]);
    await reopened.close({ checkpoint: true });
    const page = await listSessionTimelinePage(record.acpxRecordId);
    assert.equal((await resolveSessionRecord(record.acpxRecordId)).timeline?.epoch, epoch);
    assert.deepEqual(
      page.items.flatMap((item) => ("payload" in item ? [item.seq] : [])),
      [1, 2],
    );
  });
});

test("a corrupt timeline tail is disclosed and rotates the epoch before the next append", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-corrupt-tail", cwd);
    await writeSessionRecord(record);
    const writer = await SessionTimelineWriter.open(record);
    await writer.appendAcpEvents([
      captureAcpTimelineEvent("inbound", updateMessage(record.acpSessionId, "kept")),
    ]);
    await writer.close({ checkpoint: true });

    const before = await resolveSessionRecord(record.acpxRecordId);
    assert.ok(before.timeline);
    const originalEpoch = before.timeline.epoch;
    await fs.appendFile(before.timeline.active_path, "{not-json}\n", "utf8");

    const corruptPage = await listSessionTimelinePage(record.acpxRecordId);
    assert.equal(corruptPage.coverage, "incomplete");
    assert.equal(corruptPage.items[0]?.schema, "acpx.session_history_gap.v1");
    assert.equal(
      corruptPage.items[0] && "reason" in corruptPage.items[0]
        ? corruptPage.items[0].reason
        : undefined,
      "corrupt",
    );

    const reopened = await SessionTimelineWriter.open(before);
    await reopened.appendAcpEvents([
      captureAcpTimelineEvent("inbound", updateMessage(record.acpSessionId, "new epoch")),
    ]);
    await reopened.close({ checkpoint: true });

    const stored = await resolveSessionRecord(record.acpxRecordId);
    assert.notEqual(stored.timeline?.epoch, originalEpoch);
    assert.equal(stored.timeline?.last_seq, 1);
    assert.equal(stored.timeline?.history_incomplete, true);
    const page = await listSessionTimelinePage(record.acpxRecordId);
    assert.equal(page.coverage, "incomplete");
    assert.deepEqual(
      page.items.flatMap((item) => ("payload" in item ? [item.seq] : [])),
      [1],
    );
  });
});

test("an empty timeline page exposes its authoritative epoch", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-empty-epoch", cwd);
    await writeSessionRecord(record);
    const writer = await SessionTimelineWriter.open(record);
    await writer.close({ checkpoint: true });

    const stored = await resolveSessionRecord(record.acpxRecordId);
    assert.ok(stored.timeline);
    const page = await listSessionTimelinePage(record.acpxRecordId);
    assert.equal(page.epoch, stored.timeline.epoch);
    assert.deepEqual(page.items, []);
  });
});

test("a stale record cannot resurrect an epoch after corruption rotation", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = sessionRecord("timeline-stale-epoch", cwd);
    await writeSessionRecord(initial);

    const first = await SessionTimelineWriter.open(initial);
    await first.appendLifecycleEvent({ type: "turn_submitted" }, { turnId: "before-corrupt" });
    await first.close({ checkpoint: true });
    const stale = await resolveSessionRecord(initial.acpxRecordId);
    const staleEpoch = stale.timeline?.epoch;
    assert.ok(stale.timeline?.active_path);
    await fs.appendFile(stale.timeline.active_path, "{corrupt tail\n", "utf8");

    const rotatingRecord = await resolveSessionRecord(initial.acpxRecordId);
    const rotated = await SessionTimelineWriter.open(rotatingRecord);
    await rotated.appendLifecycleEvent({ type: "turn_submitted" }, { turnId: "after-rotation" });
    await rotated.close({ checkpoint: true });
    const rotatedEpoch = rotated.getRecord().timeline?.epoch;
    assert.ok(rotatedEpoch);
    assert.notEqual(rotatedEpoch, staleEpoch);

    const writerFromStaleRecord = await SessionTimelineWriter.open(stale);
    await writerFromStaleRecord.appendLifecycleEvent(
      { type: "turn_submitted" },
      { turnId: "from-stale-record" },
    );
    await writerFromStaleRecord.close({ checkpoint: true });

    const persisted = await resolveSessionRecord(initial.acpxRecordId);
    assert.equal(persisted.timeline?.epoch, rotatedEpoch);
    const page = await listSessionTimelinePage(initial.acpxRecordId, { limit: 20 });
    assert.equal(page.coverage, "incomplete");
    assert.deepEqual(
      page.items.filter((item) => "seq" in item).map((item) => item.turn_id),
      ["after-rotation", "from-stale-record"],
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

test("first activation imports retained compatibility messages without rewriting the stream", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-legacy-import", cwd);
    const messages = [
      updateMessage(record.acpSessionId, "retained one"),
      updateMessage(record.acpSessionId, "retained two"),
    ];
    record.lastSeq = messages.length;
    record.eventLog.last_write_at = "2026-08-12T09:00:00.000Z";
    await writeSessionRecord(record);
    await fs.writeFile(
      sessionEventActivePath(record.acpxRecordId),
      messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
      "utf8",
    );
    const originalStream = await fs.readFile(sessionEventActivePath(record.acpxRecordId), "utf8");

    const writer = await SessionEventWriter.open(record);
    await writer.close({ checkpoint: true });

    const page = await listSessionTimelinePage(record.acpxRecordId);
    assert.equal(page.coverage, "legacy_retained");
    assert.equal(page.items[0]?.schema, "acpx.session_history_gap.v1");
    const imported = page.items.slice(1).flatMap((item) =>
      "payload" in item && item.payload.kind === "acp"
        ? [
            {
              direction: item.direction,
              capturedAt: item.captured_at,
              source: item.payload.source,
              message: item.payload.message,
            },
          ]
        : [],
    );
    assert.deepEqual(
      imported.map((item) => item.message),
      messages,
    );
    assert.deepEqual(
      imported.map((item) => item.direction),
      ["internal", "internal"],
    );
    assert.deepEqual(
      imported.map((item) => item.source),
      ["legacy_stream", "legacy_stream"],
    );
    const stored = await resolveSessionRecord(record.acpxRecordId);
    assert.equal(stored.timeline?.legacy_import_complete, true);
    assert.deepEqual(
      imported.map((item) => item.capturedAt),
      [stored.timeline?.created_at, stored.timeline?.created_at],
    );
    assert.equal(
      await fs.readFile(sessionEventActivePath(record.acpxRecordId), "utf8"),
      originalStream,
    );
    assert.deepEqual(await listSessionEvents(record.acpxRecordId), messages);
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

test("oversized events become explicit bounded markers without breaking pagination", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-oversized-write", cwd);
    await writeSessionRecord(record);
    const writer = await SessionTimelineWriter.open(record);
    const capturedAt = "2026-08-12T10:00:01.000Z";
    await writer.appendAcpEvents([
      {
        direction: "inbound",
        message: updateMessage(record.acpSessionId, "before"),
        capturedAt,
      },
      {
        direction: "inbound",
        message: updateMessage(
          record.acpSessionId,
          "oversized:".concat("x".repeat(SESSION_TIMELINE_MAX_EVENT_BYTES * 2)),
        ),
        capturedAt,
        turnId: "turn-large",
      },
      {
        direction: "inbound",
        message: updateMessage(record.acpSessionId, "after"),
        capturedAt,
      },
    ]);
    await writer.close({ checkpoint: true });

    const stored = await resolveSessionRecord(record.acpxRecordId);
    assert.ok(stored.timeline);
    const lines = (await fs.readFile(stored.timeline.active_path, "utf8")).trimEnd().split("\n");
    assert.equal(lines.length, 3);
    assert.equal(
      lines.every((line) => Buffer.byteLength(line, "utf8") <= SESSION_TIMELINE_MAX_EVENT_BYTES),
      true,
    );

    const latest = await listSessionTimelinePage(record.acpxRecordId, { limit: 1 });
    assert.deepEqual(
      latest.items.map((item) => ("payload" in item ? item.seq : 0)),
      [3],
    );
    assert.equal(latest.hasMore, true);
    const middle = await listSessionTimelinePage(record.acpxRecordId, {
      before: latest.previousCursor,
      limit: 1,
    });
    const marker = middle.items[0];
    assert.ok(marker && "payload" in marker);
    assert.equal(marker.seq, 2);
    assert.equal(marker.payload.kind, "truncated");
    if (marker.payload.kind === "truncated") {
      assert.equal(marker.payload.reason, "event_size_limit");
      assert.equal(marker.payload.original_kind, "acp");
      assert.equal(marker.payload.original_bytes > SESSION_TIMELINE_MAX_EVENT_BYTES, true);
      assert.equal(marker.payload.limit_bytes, SESSION_TIMELINE_MAX_EVENT_BYTES);
      assert.equal(marker.payload.summary, "ACP method: session/update");
    }
    assert.equal(middle.hasMore, true);
    const oldest = await listSessionTimelinePage(record.acpxRecordId, {
      before: middle.previousCursor,
      limit: 1,
    });
    assert.deepEqual(
      oldest.items.map((item) => ("payload" in item ? item.seq : 0)),
      [1],
    );
    assert.equal(oldest.hasMore, false);
  });
});

test("reverse reads project a pre-existing oversized line instead of accumulating it", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-oversized-retained", cwd);
    await writeSessionRecord(record);
    const writer = await SessionTimelineWriter.open(record);
    await writer.appendAcpEvents([
      {
        direction: "inbound",
        message: updateMessage(record.acpSessionId, "before"),
        capturedAt: "2026-08-12T10:00:01.000Z",
      },
    ]);
    await writer.close({ checkpoint: true });
    const stored = await resolveSessionRecord(record.acpxRecordId);
    assert.ok(stored.timeline);
    const oversized = {
      schema: "acpx.session_event.v1",
      acpx_record_id: stored.acpxRecordId,
      epoch: stored.timeline.epoch,
      seq: 2,
      captured_at: "2026-08-12T10:00:02.000Z",
      direction: "inbound",
      payload: {
        kind: "acp",
        message: updateMessage(
          record.acpSessionId,
          "retained:".concat("y".repeat(SESSION_TIMELINE_MAX_EVENT_BYTES * 3)),
        ),
      },
    };
    const oversizedLine = JSON.stringify(oversized);
    await fs.appendFile(stored.timeline.active_path, `${oversizedLine}\n`, "utf8");
    stored.timeline.last_seq = 2;
    await writeSessionRecord(stored);

    const page = await listSessionTimelinePage(record.acpxRecordId, { limit: 10 });
    assert.equal(page.coverage, "complete");
    assert.deepEqual(
      page.items.map((item) => ("payload" in item ? item.seq : 0)),
      [1, 2],
    );
    const retainedMarker = page.items[1];
    assert.ok(retainedMarker && "payload" in retainedMarker);
    assert.equal(retainedMarker.payload.kind, "truncated");
    if (retainedMarker.payload.kind === "truncated") {
      assert.equal(retainedMarker.payload.original_bytes, Buffer.byteLength(oversizedLine, "utf8"));
      assert.equal(retainedMarker.payload.original_kind, "acp");
      assert.equal(retainedMarker.payload.association_omitted, true);
    }
  });
});

test("timeline pages are byte bounded and cursors cover every retained event", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-byte-pages", cwd);
    await writeSessionRecord(record);
    const writer = await SessionTimelineWriter.open(record);
    for (let index = 1; index <= 24; index += 1) {
      await writer.appendAcpEvents([
        {
          direction: "inbound",
          message: updateMessage(record.acpSessionId, `${index}:`.concat("z".repeat(70_000))),
          capturedAt: "2026-08-12T10:00:01.000Z",
        },
      ]);
    }
    await writer.close({ checkpoint: true });

    const sequences: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listSessionTimelinePage(record.acpxRecordId, {
        before: cursor,
        limit: 1_000,
      });
      pages += 1;
      assert.equal(
        Buffer.byteLength(JSON.stringify(page), "utf8") <= SESSION_TIMELINE_MAX_PAGE_BYTES,
        true,
      );
      sequences.unshift(...page.items.flatMap((item) => ("payload" in item ? [item.seq] : [])));
      cursor = page.previousCursor;
      if (!page.hasMore) {
        break;
      }
      assert.ok(cursor);
    } while (cursor);
    assert.equal(pages > 1, true);
    assert.deepEqual(
      sequences,
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    assert.equal(new Set(sequences).size, 24);
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

test("queued turn projection survives reload with exact ids and prompt text", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-queued-projection", cwd);
    await writeSessionRecord(record);
    const writer = await SessionEventWriter.open(record);
    await writer.appendLifecycleEvent(
      { type: "turn_submitted", prompt_text: "First durable follow-up" },
      { turnId: "turn-first", capturedAt: "2026-08-12T10:00:01.000Z" },
    );
    await writer.appendLifecycleEvent(
      { type: "turn_submitted", prompt_text: "Second durable follow-up" },
      { turnId: "turn-second", capturedAt: "2026-08-12T10:00:02.000Z" },
    );
    await writer.appendLifecycleEvent({ type: "turn_started" }, { turnId: "turn-first" });
    await writer.appendLifecycleEvent(
      { type: "turn_submitted" },
      { turnId: "turn-legacy", capturedAt: "2026-08-12T10:00:03.000Z" },
    );
    await writer.appendLifecycleEvent({ type: "turn_cancelled" }, { turnId: "turn-legacy" });
    await writer.close({ checkpoint: true });

    assert.deepEqual(await listQueuedSessionTimelineTurns(record.acpxRecordId), [
      {
        turnId: "turn-second",
        submittedAt: "2026-08-12T10:00:02.000Z",
        promptText: "Second durable follow-up",
      },
    ]);
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

test("a transcript read waiting behind prune cannot resurrect the primary record", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-prune-read-race", cwd);
    record.closed = true;
    record.closedAt = "2026-08-12T10:01:00.000Z";
    record.lastSeq = 1;
    record.eventLog.last_write_at = "2026-08-12T10:00:00.000Z";
    await writeSessionRecord(record);
    await fs.writeFile(
      sessionEventActivePath(record.acpxRecordId),
      `${JSON.stringify(updateMessage(record.acpSessionId, "retained"))}\n`,
      "utf8",
    );

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = withSessionTimelineLock(record.acpxRecordId, async () => await gate);
    while (sessionTimelineTestInternals.timelineLockQueueDepth(record.acpxRecordId) < 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    const prune = pruneSessions({ includeHistory: true });
    while (sessionTimelineTestInternals.timelineLockQueueDepth(record.acpxRecordId) < 2) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    const waitingRead = SessionTimelineWriter.refreshLegacyCompatibility(record.acpxRecordId);
    release();
    await blocker;
    await prune;
    await assert.rejects(waitingRead, /Session not found/i);
    await assert.rejects(resolveSessionRecord(record.acpxRecordId), /Session not found/i);
    assert.equal(sessionTimelineTestInternals.timelineLockQueueDepth(record.acpxRecordId), 0);
  });
});

test("legacy rotation between enumeration and open neither loses nor duplicates either inode", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-legacy-rotation-race", cwd);
    record.lastSeq = 2;
    record.eventLog.last_write_at = "2026-08-12T10:00:00.000Z";
    await writeSessionRecord(record);
    const activePath = sessionEventActivePath(record.acpxRecordId);
    const segmentPath = sessionEventSegmentPath(record.acpxRecordId, 1);
    const first = updateMessage(record.acpSessionId, "before rotation");
    const second = updateMessage(record.acpSessionId, "after rotation");
    await fs.writeFile(activePath, `${JSON.stringify(first)}\n`, "utf8");

    sessionTimelineTestInternals.beforeNextLegacySourceOpen(async (source) => {
      assert.equal(source.filePath, activePath);
      await fs.rename(activePath, segmentPath);
      await fs.writeFile(activePath, `${JSON.stringify(second)}\n`, "utf8");
    });

    assert.equal(await SessionTimelineWriter.refreshLegacyCompatibility(record.acpxRecordId), true);
    assert.equal(
      await SessionTimelineWriter.refreshLegacyCompatibility(record.acpxRecordId),
      false,
    );
    assert.equal(
      await SessionTimelineWriter.refreshLegacyCompatibility(record.acpxRecordId),
      false,
    );
    const page = await listSessionTimelinePage(record.acpxRecordId, { limit: 20 });
    assert.deepEqual(
      page.items.flatMap((item) =>
        "payload" in item && item.payload.kind === "acp" ? [item.payload.message] : [],
      ),
      [first, second],
    );
  });
});

test("an unlink failure cannot poison the in-process timeline lock queue", async () => {
  await withTempHome(async () => {
    const sessionId = "timeline-release-recovery";
    sessionTimelineTestInternals.failNextTimelineLockUnlinks(3);
    await assert.rejects(
      withSessionTimelineLock(sessionId, async () => "first"),
      /Injected timeline lock unlink failure/,
    );
    assert.equal(sessionTimelineTestInternals.timelineLockQueueDepth(sessionId), 0);

    const second = await Promise.race([
      withSessionTimelineLock(sessionId, async () => "second"),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("second timeline lock operation stalled")), 1_000),
      ),
    ]);
    assert.equal(second, "second");
    assert.equal(sessionTimelineTestInternals.timelineLockQueueDepth(sessionId), 0);
  });
});

test("a stale legacy-owner observation cannot duplicate a modern compatibility twin", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = sessionRecord("timeline-stale-legacy-owner", cwd);
    const legacy = updateMessage(record.acpSessionId, "legacy");
    const modern = updateMessage(record.acpSessionId, "modern");
    record.lastSeq = 1;
    record.eventLog.last_write_at = "2026-08-12T10:00:00.000Z";
    await writeSessionRecord(record);
    await fs.writeFile(
      sessionEventActivePath(record.acpxRecordId),
      `${JSON.stringify(legacy)}\n`,
      "utf8",
    );
    await SessionTimelineWriter.refreshLegacyCompatibility(record.acpxRecordId, {
      legacyOwnerCanAppend: () => true,
    });

    const writer = await SessionEventWriter.open(await resolveSessionRecord(record.acpxRecordId));
    await writer.appendMessage(modern);
    await writer.close({ checkpoint: true });

    // The service may have decided to refresh while the old owner was still
    // visible, but the callback is evaluated only now, under the timeline
    // lock. It sees the modern owner and the completed metadata, so it skips.
    let capabilityChecks = 0;
    assert.equal(
      await SessionTimelineWriter.refreshLegacyCompatibility(record.acpxRecordId, {
        legacyOwnerCanAppend: () => {
          capabilityChecks += 1;
          return false;
        },
      }),
      false,
    );
    assert.equal(capabilityChecks, 1);
    const page = await listSessionTimelinePage(record.acpxRecordId, { limit: 20 });
    assert.deepEqual(
      page.items.flatMap((item) =>
        "payload" in item && item.payload.kind === "acp" ? [item.payload.message] : [],
      ),
      [legacy, modern],
    );
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

test("concurrent timeline appends serialize without losing or reusing a sequence", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = sessionRecord("timeline-concurrent", cwd);
    await writeSessionRecord(initial);

    // Each call resolves the record independently, matching separate service or
    // console processes racing to append lifecycle evidence for one session.
    const appendFromIndependentWriter = async (turnId: string): Promise<void> => {
      const record = await resolveSessionRecord(initial.acpxRecordId);
      await appendSessionTimelineLifecycleEvent(
        record,
        { type: "turn_submitted" },
        { turnId, requestId: turnId },
      );
    };
    await Promise.all(
      Array.from({ length: 12 }, async (_value, index) => {
        await appendFromIndependentWriter(`turn-${index}`);
      }),
    );

    const page = await listSessionTimelinePage(initial.acpxRecordId, { limit: 100 });
    const events = page.items.filter((item) => "seq" in item);
    assert.deepEqual(
      events.map((event) => event.seq),
      Array.from({ length: 12 }, (_value, index) => index + 1),
    );
    assert.deepEqual(
      events
        .map((event) => event.turn_id)
        .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
      Array.from({ length: 12 }, (_value, index) => `turn-${index}`).toSorted((left, right) =>
        left.localeCompare(right),
      ),
    );
    assert.equal(page.coverage, "complete");
    const persisted = await resolveSessionRecord(initial.acpxRecordId);
    assert.equal(persisted.timeline?.last_seq, 12);
  });
});

test("an active turn writer never blocks a queued turn submission", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = sessionRecord("timeline-live-and-queued", cwd);
    await writeSessionRecord(initial);

    const activeWriter = await SessionEventWriter.open(initial);
    await activeWriter.appendLifecycleEvent(
      { type: "turn_started" },
      { turnId: "turn-active", requestId: "turn-active" },
    );

    const queuedRecord = await resolveSessionRecord(initial.acpxRecordId);
    const queuedAppend = appendSessionTimelineLifecycleEvent(
      queuedRecord,
      { type: "turn_submitted" },
      { turnId: "turn-queued", requestId: "turn-queued" },
    );
    const admittedPromptly = await Promise.race([
      queuedAppend.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);

    if (!admittedPromptly) {
      // Release the pre-fix long-lived lock so the failed assertion cannot
      // strand a background append or leak a lock into test cleanup.
      await activeWriter.close({ checkpoint: true });
      await queuedAppend;
      assert.fail("queued turn submission waited for the active turn writer to close");
    }

    // A long-lived writer still owns a stale record object here. Its ordinary
    // session checkpoint must merge, not overwrite, the independent append.
    await activeWriter.checkpoint();
    assert.equal((await resolveSessionRecord(initial.acpxRecordId)).timeline?.last_seq, 2);

    await activeWriter.appendLifecycleEvent(
      { type: "turn_completed", stop_reason: "end_turn" },
      { turnId: "turn-active", requestId: "turn-active" },
    );
    await activeWriter.close({ checkpoint: true });

    const page = await listSessionTimelinePage(initial.acpxRecordId, { limit: 20 });
    const events = page.items.filter((item) => "seq" in item);
    assert.deepEqual(
      events.map((event) => [
        event.seq,
        event.turn_id,
        event.payload.kind === "lifecycle" ? event.payload.event.type : "acp",
      ]),
      [
        [1, "turn-active", "turn_started"],
        [2, "turn-queued", "turn_submitted"],
        [3, "turn-active", "turn_completed"],
      ],
    );
    assert.equal((await resolveSessionRecord(initial.acpxRecordId)).timeline?.last_seq, 3);
  });
});
