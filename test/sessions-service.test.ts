import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { MAX_MESSAGE_BUFFER_SIZE } from "../src/cli/queue/ipc.js";
import {
  QUEUE_PROTOCOL_PROMPT_QUEUE_SNAPSHOT_VERSION,
  QUEUE_PROTOCOL_VERSION,
} from "../src/cli/queue/lease-store.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import { SessionEventWriter } from "../src/session/events.js";
import {
  PENDING_REQUEST_SCHEMA,
  writePendingRequest,
  type PendingRequest,
} from "../src/session/pending-requests.js";
import {
  listOpenSessionsForSubscription,
  listSessions as listStoredSessions,
  resolveSessionRecord,
} from "../src/session/persistence.js";
import { appendSessionTimelineLifecycleEvent } from "../src/session/timeline.js";
import { sessionsServiceTestInternals } from "../src/sessions-service/service.js";
import { AcpxTurnNotActiveError, createAcpxSessionService } from "../src/sessions.js";
import type { AcpJsonRpcMessage } from "../src/types.js";
import {
  cleanupOwnerArtifacts,
  closeServer,
  createSingleRequestServer,
  listenServer,
  queuePaths,
  startKeeperProcess,
  stopProcess,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

function retainedMessage(sessionId: string, text: string): AcpJsonRpcMessage {
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
  };
}

test("session lookup requires an exact acpx record id and returns browser-safe DTOs", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "session-exact-abcdef",
      acpSessionId: "provider-secret-id",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { resume: null, close: null, list: null },
      },
    });
    await writeSessionRecordFile(homeDir, record);
    const service = createAcpxSessionService({ cwd });

    assert.equal(await service.getSession({ acpxRecordId: "abcdef" }), undefined);
    const projected = await service.getSession({ acpxRecordId: record.acpxRecordId });
    assert.equal(projected?.acpxRecordId, record.acpxRecordId);
    assert.equal(Object.hasOwn(projected ?? {}, "agentCommand"), false);
    assert.equal(Object.hasOwn(projected ?? {}, "messages"), false);
    assert.equal(Object.hasOwn(projected ?? {}, "authCredentials"), false);
    assert.deepEqual(projected?.agentCapabilities, {
      loadSession: false,
      resumeSession: false,
      closeSession: false,
      listSessions: false,
    });
    service.dispose();
  });
});

test("the first transcript read imports retained chat idempotently before any mutation", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "session-first-transcript-read",
      acpSessionId: "provider-first-transcript-read",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    const messages = [
      retainedMessage(record.acpSessionId, "Retained first"),
      retainedMessage(record.acpSessionId, "Retained second"),
    ];
    record.lastSeq = messages.length;
    record.eventLog.last_write_at = "2026-08-13T08:00:00.000Z";
    await writeSessionRecordFile(homeDir, record);
    await fs.writeFile(
      sessionEventActivePath(record.acpxRecordId),
      `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
      "utf8",
    );
    const service = createAcpxSessionService({ cwd });
    try {
      const first = await service.getTranscriptPage({
        acpxRecordId: record.acpxRecordId,
        limit: 20,
      });
      const second = await service.getTranscriptPage({
        acpxRecordId: record.acpxRecordId,
        limit: 20,
      });
      const projected = (page: typeof first) =>
        page.items.flatMap((item) =>
          "payload" in item && item.payload.kind === "acp" ? [item.payload.message] : [],
        );
      assert.deepEqual(projected(first), messages);
      assert.deepEqual(projected(second), messages);
      assert.equal(first.coverage, "legacy_retained");
      assert.equal(second.items.length, first.items.length, "second read duplicated retained chat");
      assert.equal(
        (await resolveSessionRecord(record.acpxRecordId)).timeline?.legacy_import_complete,
        true,
      );
    } finally {
      service.dispose();
    }
  });
});

test("first read recovers a compatibility append that crashed before its record checkpoint", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "session-uncheckpointed-compatibility",
      acpSessionId: "provider-uncheckpointed-compatibility",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    const retained = retainedMessage(record.acpSessionId, "Durable before checkpoint");
    assert.equal(record.lastSeq, 0);
    assert.equal(record.timeline, undefined);
    await writeSessionRecordFile(homeDir, record);
    await fs.writeFile(
      sessionEventActivePath(record.acpxRecordId),
      `${JSON.stringify(retained)}\n`,
      "utf8",
    );

    const service = createAcpxSessionService({ cwd });
    try {
      const page = await service.getTranscriptPage({
        acpxRecordId: record.acpxRecordId,
        limit: 20,
      });
      assert.deepEqual(
        page.items.flatMap((item) =>
          "payload" in item && item.payload.kind === "acp" ? [item.payload.message] : [],
        ),
        [retained],
      );
      assert.equal(page.coverage, "legacy_retained");
    } finally {
      service.dispose();
    }
  });
});

test("later compatibility appends appear on the next transcript read exactly once", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "session-later-legacy-append",
      acpSessionId: "provider-later-legacy-append",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    const firstMessage = retainedMessage(record.acpSessionId, "Retained first");
    const laterMessage = retainedMessage(record.acpSessionId, "Appended by warm owner");
    record.lastSeq = 1;
    record.eventLog.last_write_at = "2026-08-13T08:00:00.000Z";
    await writeSessionRecordFile(homeDir, record);
    const streamPath = sessionEventActivePath(record.acpxRecordId);
    await fs.writeFile(streamPath, `${JSON.stringify(firstMessage)}\n`, "utf8");
    const keeper = await startKeeperProcess();
    const ownerPaths = queuePaths(homeDir, record.acpxRecordId);
    await writeQueueOwnerLock({
      ...ownerPaths,
      pid: keeper.pid,
      sessionId: record.acpxRecordId,
      queueProtocol: 1,
    });
    const service = createAcpxSessionService({ cwd });
    try {
      await service.getTranscriptPage({ acpxRecordId: record.acpxRecordId, limit: 20 });
      await fs.appendFile(streamPath, `${JSON.stringify(laterMessage)}\n`, "utf8");
      const second = await service.getTranscriptPage({
        acpxRecordId: record.acpxRecordId,
        limit: 20,
      });
      const third = await service.getTranscriptPage({
        acpxRecordId: record.acpxRecordId,
        limit: 20,
      });
      const messages = (page: typeof second) =>
        page.items.flatMap((item) =>
          "payload" in item && item.payload.kind === "acp" ? [item.payload.message] : [],
        );
      assert.deepEqual(messages(second), [firstMessage, laterMessage]);
      assert.deepEqual(messages(third), [firstMessage, laterMessage]);
    } finally {
      service.dispose();
      await cleanupOwnerArtifacts(ownerPaths);
      stopProcess(keeper);
    }
  });
});

test("a live legacy owner can append its first retained message after an empty read", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "session-first-late-legacy-append",
      acpSessionId: "provider-first-late-legacy-append",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, record);
    const keeper = await startKeeperProcess();
    const ownerPaths = queuePaths(homeDir, record.acpxRecordId);
    await writeQueueOwnerLock({
      ...ownerPaths,
      pid: keeper.pid,
      sessionId: record.acpxRecordId,
      queueProtocol: 2,
    });
    const service = createAcpxSessionService({ cwd });
    try {
      const empty = await service.getTranscriptPage({
        acpxRecordId: record.acpxRecordId,
        limit: 20,
      });
      assert.equal(empty.items.filter((item) => "payload" in item).length, 0);

      const later = retainedMessage(record.acpSessionId, "First retained message");
      await fs.writeFile(
        sessionEventActivePath(record.acpxRecordId),
        `${JSON.stringify(later)}\n`,
        "utf8",
      );
      const hydrated = await service.getTranscriptPage({
        acpxRecordId: record.acpxRecordId,
        limit: 20,
      });
      assert.deepEqual(
        hydrated.items.flatMap((item) =>
          "payload" in item && item.payload.kind === "acp" ? [item.payload.message] : [],
        ),
        [later],
      );
    } finally {
      service.dispose();
      await cleanupOwnerArtifacts(ownerPaths);
      stopProcess(keeper);
    }
  });
});

test("the final legacy suffix is recovered after its owner exits", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "session-final-legacy-suffix",
      acpSessionId: "provider-final-legacy-suffix",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    const firstMessage = retainedMessage(record.acpSessionId, "Before owner exit");
    const finalMessage = retainedMessage(record.acpSessionId, "Final owner suffix");
    record.lastSeq = 2;
    record.eventLog.last_write_at = "2026-08-13T08:00:00.000Z";
    await writeSessionRecordFile(homeDir, record);
    const streamPath = sessionEventActivePath(record.acpxRecordId);
    await fs.writeFile(streamPath, `${JSON.stringify(firstMessage)}\n`, "utf8");
    const keeper = await startKeeperProcess();
    const ownerPaths = queuePaths(homeDir, record.acpxRecordId);
    await writeQueueOwnerLock({
      ...ownerPaths,
      pid: keeper.pid,
      sessionId: record.acpxRecordId,
      queueProtocol: 1,
    });
    const service = createAcpxSessionService({ cwd });
    try {
      const first = await service.getTranscriptPage({
        acpxRecordId: record.acpxRecordId,
        limit: 20,
      });
      assert.deepEqual(
        first.items.flatMap((item) =>
          "payload" in item && item.payload.kind === "acp" ? [item.payload.message] : [],
        ),
        [firstMessage],
      );
      assert.equal(
        (await resolveSessionRecord(record.acpxRecordId)).timeline?.legacy_import_complete,
        false,
      );

      await fs.appendFile(streamPath, `${JSON.stringify(finalMessage)}\n`, "utf8");
      await cleanupOwnerArtifacts(ownerPaths);
      stopProcess(keeper);

      const caughtUp = await service.getTranscriptPage({
        acpxRecordId: record.acpxRecordId,
        limit: 20,
      });
      const repeated = await service.getTranscriptPage({
        acpxRecordId: record.acpxRecordId,
        limit: 20,
      });
      const messages = (page: typeof caughtUp) =>
        page.items.flatMap((item) =>
          "payload" in item && item.payload.kind === "acp" ? [item.payload.message] : [],
        );
      assert.deepEqual(messages(caughtUp), [firstMessage, finalMessage]);
      assert.deepEqual(messages(repeated), [firstMessage, finalMessage]);
      assert.equal(
        (await resolveSessionRecord(record.acpxRecordId)).timeline?.legacy_import_complete,
        true,
      );
    } finally {
      service.dispose();
      await cleanupOwnerArtifacts(ownerPaths);
      stopProcess(keeper);
    }
  });
});

test("a modern writer catches the final legacy suffix before writing compatibility twins", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "session-legacy-to-modern-handoff",
      acpSessionId: "provider-legacy-to-modern-handoff",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    const first = retainedMessage(record.acpSessionId, "Legacy first");
    const suffix = retainedMessage(record.acpSessionId, "Legacy final suffix");
    const modern = retainedMessage(record.acpSessionId, "Modern event");
    record.lastSeq = 2;
    record.eventLog.last_write_at = "2026-08-13T08:00:00.000Z";
    await writeSessionRecordFile(homeDir, record);
    const streamPath = sessionEventActivePath(record.acpxRecordId);
    await fs.writeFile(streamPath, `${JSON.stringify(first)}\n`, "utf8");
    const keeper = await startKeeperProcess();
    const ownerPaths = queuePaths(homeDir, record.acpxRecordId);
    await writeQueueOwnerLock({
      ...ownerPaths,
      pid: keeper.pid,
      sessionId: record.acpxRecordId,
      queueProtocol: 1,
    });
    const service = createAcpxSessionService({ cwd });
    try {
      await service.getTranscriptPage({ acpxRecordId: record.acpxRecordId, limit: 20 });
      await fs.appendFile(streamPath, `${JSON.stringify(suffix)}\n`, "utf8");
      await cleanupOwnerArtifacts(ownerPaths);
      stopProcess(keeper);

      const writer = await SessionEventWriter.open(await resolveSessionRecord(record.acpxRecordId));
      await writer.appendMessage(modern);
      await writer.close({ checkpoint: true });

      const page = await service.getTranscriptPage({
        acpxRecordId: record.acpxRecordId,
        limit: 20,
      });
      assert.deepEqual(
        page.items.flatMap((item) =>
          "payload" in item && item.payload.kind === "acp" ? [item.payload.message] : [],
        ),
        [first, suffix, modern],
      );
    } finally {
      service.dispose();
      await cleanupOwnerArtifacts(ownerPaths);
      stopProcess(keeper);
    }
  });
});

test("modern timeline appends are not re-imported from their compatibility copy", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "session-modern-no-duplicate",
      acpSessionId: "provider-modern-no-duplicate",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    const retained = retainedMessage(record.acpSessionId, "Retained");
    const modern = retainedMessage(record.acpSessionId, "Modern");
    record.lastSeq = 1;
    record.eventLog.last_write_at = "2026-08-13T08:00:00.000Z";
    await writeSessionRecordFile(homeDir, record);
    await fs.writeFile(
      sessionEventActivePath(record.acpxRecordId),
      `${JSON.stringify(retained)}\n`,
      "utf8",
    );
    const service = createAcpxSessionService({ cwd });
    const keeper = await startKeeperProcess();
    const ownerPaths = queuePaths(homeDir, record.acpxRecordId);
    try {
      await service.getTranscriptPage({ acpxRecordId: record.acpxRecordId, limit: 20 });
      const writer = await SessionEventWriter.open(await resolveSessionRecord(record.acpxRecordId));
      await writer.appendMessage(modern);
      await writer.close({ checkpoint: true });
      await writeQueueOwnerLock({
        ...ownerPaths,
        pid: keeper.pid,
        sessionId: record.acpxRecordId,
        timeline: true,
      });
      const page = await service.getTranscriptPage({
        acpxRecordId: record.acpxRecordId,
        limit: 20,
      });
      assert.deepEqual(
        page.items.flatMap((item) =>
          "payload" in item && item.payload.kind === "acp" ? [item.payload.message] : [],
        ),
        [retained, modern],
      );
    } finally {
      service.dispose();
      await cleanupOwnerArtifacts(ownerPaths);
      stopProcess(keeper);
    }
  });
});

test("legacy first-read migration is bounded and advertises continuation", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "session-bounded-legacy-import",
      acpSessionId: "provider-bounded-legacy-import",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    const count = 2_049;
    record.lastSeq = count;
    record.eventLog.last_write_at = "2026-08-13T08:00:00.000Z";
    await writeSessionRecordFile(homeDir, record);
    await fs.writeFile(
      sessionEventActivePath(record.acpxRecordId),
      `${Array.from({ length: count }, (_value, index) =>
        JSON.stringify(retainedMessage(record.acpSessionId, `message-${index}`)),
      ).join("\n")}\n`,
      "utf8",
    );
    const service = createAcpxSessionService({ cwd });
    try {
      const first = await service.getTranscriptPage({
        acpxRecordId: record.acpxRecordId,
        limit: 20,
      });
      assert.equal(first.legacyImportPending, true);
      assert.equal((await resolveSessionRecord(record.acpxRecordId)).timeline?.last_seq, 2_048);
      const second = await service.getTranscriptPage({
        acpxRecordId: record.acpxRecordId,
        limit: 20,
      });
      assert.equal(second.legacyImportPending, undefined);
      assert.equal((await resolveSessionRecord(record.acpxRecordId)).timeline?.last_seq, count);
    } finally {
      service.dispose();
    }
  });
});

test("a truncated terminal compatibility fragment does not request endless continuation", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "session-truncated-legacy-tail",
      acpSessionId: "provider-truncated-legacy-tail",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    const retained = retainedMessage(record.acpSessionId, "Retained");
    record.lastSeq = 2;
    record.eventLog.last_write_at = "2026-08-13T08:00:00.000Z";
    await writeSessionRecordFile(homeDir, record);
    await fs.writeFile(
      sessionEventActivePath(record.acpxRecordId),
      `${JSON.stringify(retained)}\n{"jsonrpc":"2.0","method":`,
      "utf8",
    );
    const service = createAcpxSessionService({ cwd });
    try {
      const first = await service.getTranscriptPage({
        acpxRecordId: record.acpxRecordId,
        limit: 20,
      });
      const second = await service.getTranscriptPage({
        acpxRecordId: record.acpxRecordId,
        limit: 20,
      });
      assert.equal(first.legacyImportPending, undefined);
      assert.equal(second.legacyImportPending, undefined);
      assert.equal(
        second.items.filter((item) => "payload" in item && item.payload.kind === "acp").length,
        1,
      );
    } finally {
      service.dispose();
    }
  });
});

test("bounded session projection preserves order and caps concurrent owner work", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let peak = 0;
  const work = Array.from({ length: 12 }, (_, index) => index);
  const pending = sessionsServiceTestInternals.mapConcurrentBounded(work, 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await gate;
    active -= 1;
    return value * 2;
  });
  await Promise.resolve();
  assert.equal(active, 3);
  assert.equal(peak, 3);
  release();
  assert.deepEqual(
    await pending,
    work.map((value) => value * 2),
  );
  assert.equal(peak, 3);
});

test("an explicit empty subscription scope observes no sessions", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeSessionRecordFile(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-empty-subscription-scope",
        acpSessionId: "provider-empty-subscription-scope",
        agentCommand: AGENT_REGISTRY.codex,
        cwd,
      }),
    );
    assert.deepEqual(
      await sessionsServiceTestInternals.listSubscriptionRecords({
        cwd,
        subscriptionWorkspaceRoots: [],
      }),
      [],
    );
    assert.equal(
      (await sessionsServiceTestInternals.listSubscriptionRecords({ cwd })).length,
      1,
      "an omitted explicit scope should still inherit cwd",
    );
  });
});

test("a malformed retained workspace config cannot break session projections", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const healthyCwd = path.join(homeDir, "healthy-workspace");
    const malformedCwd = path.join(homeDir, "malformed-workspace");
    await Promise.all([
      fs.mkdir(healthyCwd, { recursive: true }),
      fs.mkdir(malformedCwd, { recursive: true }),
    ]);
    await fs.writeFile(path.join(malformedCwd, ".acpxrc.json"), "{ invalid json", "utf8");

    const healthy = makeSessionRecord({
      acpxRecordId: "session-healthy-config",
      acpSessionId: "provider-healthy-config",
      agentCommand: AGENT_REGISTRY.codex,
      cwd: healthyCwd,
      acpx: { agent_id: "codex" },
    });
    const retained = makeSessionRecord({
      acpxRecordId: "session-malformed-config",
      acpSessionId: "provider-malformed-config",
      agentCommand: "custom-agent --stdio",
      cwd: malformedCwd,
      acpx: { agent_id: "custom-agent" },
    });
    await Promise.all([
      writeSessionRecordFile(homeDir, healthy),
      writeSessionRecordFile(homeDir, retained),
    ]);
    const service = createAcpxSessionService({ cwd: healthyCwd });

    try {
      const sessions = await service.listSessions();
      assert.deepEqual(
        sessions
          .map(({ acpxRecordId, agentId }) => ({ acpxRecordId, agentId }))
          .toSorted((left, right) => left.acpxRecordId.localeCompare(right.acpxRecordId)),
        [
          { acpxRecordId: "session-healthy-config", agentId: "codex" },
          { acpxRecordId: "session-malformed-config", agentId: "custom-agent" },
        ],
      );
      const detail = await service.getSession({ acpxRecordId: retained.acpxRecordId });
      assert.equal(detail?.agentId, "custom-agent");
    } finally {
      service.dispose();
    }
  });
});

test("agent inventory is loaded from the exact requested workspace", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const firstCwd = path.join(homeDir, "first-workspace");
    const secondCwd = path.join(homeDir, "second-workspace");
    await Promise.all([
      fs.mkdir(firstCwd, { recursive: true }),
      fs.mkdir(secondCwd, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(
        path.join(firstCwd, ".acpxrc.json"),
        `${JSON.stringify({ agents: { first: { command: "first-agent" } } })}\n`,
        "utf8",
      ),
      fs.writeFile(
        path.join(secondCwd, ".acpxrc.json"),
        `${JSON.stringify({ agents: { second: { command: "second-agent" } } })}\n`,
        "utf8",
      ),
    ]);
    const service = createAcpxSessionService({ cwd: firstCwd });

    try {
      const secondAgents = await service.listAgents({ cwd: secondCwd });
      assert.equal(
        secondAgents.some((agent) => agent.agentId === "second"),
        true,
      );
      assert.equal(
        secondAgents.some((agent) => agent.agentId === "first"),
        false,
      );
    } finally {
      service.dispose();
    }
  });
});

test("adoption cannot reuse a provider record from another workspace", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const existingCwd = path.join(homeDir, "existing-workspace");
    const requestedCwd = path.join(homeDir, "requested-workspace");
    await Promise.all([
      fs.mkdir(existingCwd, { recursive: true }),
      fs.mkdir(requestedCwd, { recursive: true }),
    ]);
    const existing = makeSessionRecord({
      acpxRecordId: "session-provider-cross-workspace",
      acpSessionId: "provider-cross-workspace",
      agentCommand: AGENT_REGISTRY.codex,
      cwd: existingCwd,
      acpx: {
        agent_id: "codex",
        desired_mode_id: "read-only",
        current_mode_id: "read-only",
      },
    });
    await writeSessionRecordFile(homeDir, existing);
    const service = createAcpxSessionService({ cwd: requestedCwd });

    try {
      await assert.rejects(
        async () =>
          await service.adoptSession({
            agentId: "codex",
            cwd: requestedCwd,
            providerSessionId: existing.acpSessionId,
            idempotencyKey: "cross-workspace-adoption",
          }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "SESSION_ADOPTION_FAILED");
          assert.match((error as Error).message, /already adopted in workspace/u);
          return true;
        },
      );
      const retained = await resolveSessionRecord(existing.acpxRecordId);
      assert.equal(retained.cwd, path.resolve(existingCwd));
      assert.equal(retained.acpx?.desired_mode_id, "read-only");
    } finally {
      service.dispose();
    }
  });
});

test("session recovery scopes use canonical agent identity and effective normalized mode", () => {
  const aliased = sessionsServiceTestInternals.sessionStartRecoveryScope(
    {
      agentId: " factory-droid ",
      cwd: "/workspace/../workspace",
      idempotencyKey: "alias",
    },
    { agentId: "droid" },
  );
  const canonical = sessionsServiceTestInternals.sessionStartRecoveryScope(
    { agentId: "droid", cwd: "/workspace", idempotencyKey: "canonical" },
    { agentId: "droid" },
  );
  assert.deepEqual(aliased, canonical);

  const implicitDefault = sessionsServiceTestInternals.sessionStartRecoveryScope(
    { agentId: "codex", cwd: "/workspace", idempotencyKey: "implicit" },
    { agentId: "codex" },
  );
  const explicitDefault = sessionsServiceTestInternals.sessionStartRecoveryScope(
    {
      agentId: "CODEX",
      cwd: "/workspace",
      mode: "  read-only  ",
      idempotencyKey: "explicit",
    },
    { agentId: "codex" },
  );
  assert.deepEqual(implicitDefault, explicitDefault);
});

test("session invalidation fingerprints ignore heartbeat timestamps until owner health changes", async () => {
  const keeper = await startKeeperProcess();
  try {
    const record = makeSessionRecord({
      acpxRecordId: "session-heartbeat-fingerprint",
      acpSessionId: "provider-heartbeat-fingerprint",
      agentCommand: AGENT_REGISTRY.codex,
      cwd: process.cwd(),
    });
    const owner = {
      pid: keeper.pid!,
      sessionId: record.acpxRecordId,
      socketPath: "/tmp/acpx-heartbeat-fingerprint.sock",
      createdAt: "2026-08-13T10:00:00.000Z",
      heartbeatAt: new Date().toISOString(),
      ownerGeneration: 71,
      queueDepth: 0,
    };
    const first = sessionsServiceTestInternals.recordFingerprint(record, owner);
    const refreshed = sessionsServiceTestInternals.recordFingerprint(record, {
      ...owner,
      heartbeatAt: new Date(Date.now() + 1_000).toISOString(),
    });
    const stale = sessionsServiceTestInternals.recordFingerprint(record, {
      ...owner,
      heartbeatAt: "2000-01-01T00:00:00.000Z",
    });
    const queued = sessionsServiceTestInternals.recordFingerprint(record, {
      ...owner,
      queueDepth: 1,
    });

    assert.equal(refreshed, first, "a fresh heartbeat alone invalidated the session");
    assert.notEqual(stale, first, "fresh-to-stale owner health was not observable");
    assert.notEqual(queued, first, "queue-depth changes were not observable");
    assert.notEqual(
      sessionsServiceTestInternals.recordFingerprint(record, undefined),
      first,
      "owner removal was not observable",
    );
  } finally {
    stopProcess(keeper);
  }
});

test("a live owner with a stale heartbeat is unreachable, never starting", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "session-stale-owner",
      acpSessionId: "provider-stale-owner",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, record);
    const keeper = await startKeeperProcess();
    try {
      const paths = queuePaths(homeDir, record.acpxRecordId);
      await writeQueueOwnerLock({
        ...paths,
        pid: keeper.pid,
        sessionId: record.acpxRecordId,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
      });
      const detail = await createAcpxSessionService({ cwd }).getSession({
        acpxRecordId: record.acpxRecordId,
      });
      assert.equal(detail?.ownerState, "unreachable");
    } finally {
      stopProcess(keeper);
    }
  });
});

test("mode projection distinguishes stored preference, warm-owner uncertainty, and conflict", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = makeSessionRecord({
      acpxRecordId: "session-mode-assurance",
      acpSessionId: "provider-mode-assurance",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      acpx: { desired_mode_id: "read-only", current_mode_id: "read-only" },
    });
    await writeSessionRecordFile(homeDir, initial);
    const service = createAcpxSessionService({ cwd });

    const cold = await service.getSession({ acpxRecordId: initial.acpxRecordId });
    assert.equal(cold?.desiredMode, "read-only");
    assert.equal(cold?.effectiveMode, "read-only");
    assert.equal(cold?.modeState, "stored");
    assert.equal(cold?.modeRemediation, undefined);

    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, initial.acpxRecordId);
    try {
      await writeQueueOwnerLock({
        ...paths,
        pid: keeper.pid,
        sessionId: initial.acpxRecordId,
      });
      const warm = await service.getSession({ acpxRecordId: initial.acpxRecordId });
      assert.equal(warm?.modeState, "unverified");
      assert.match(warm?.modeRemediation ?? "", /retained queue owner/u);

      const conflicted = await resolveSessionRecord(initial.acpxRecordId);
      conflicted.acpx = {
        ...conflicted.acpx,
        desired_mode_id: "read-only",
        current_mode_id: "agent",
      };
      await writeSessionRecordFile(homeDir, conflicted);
      const conflict = await service.getSession({ acpxRecordId: initial.acpxRecordId });
      assert.equal(conflict?.mode, "agent");
      assert.equal(conflict?.desiredMode, "read-only");
      assert.equal(conflict?.effectiveMode, "agent");
      assert.equal(conflict?.modeState, "conflict");
      assert.match(conflict?.modeRemediation ?? "", /differs from the last adapter report/u);
    } finally {
      service.dispose();
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});

test("owner loss after dispatch never projects a turn as still running", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = makeSessionRecord({
      acpxRecordId: "session-owner-loss",
      acpSessionId: "provider-owner-loss",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, initial);
    const record = await resolveSessionRecord(initial.acpxRecordId);
    await appendSessionTimelineLifecycleEvent(
      record,
      { type: "turn_started" },
      { turnId: "turn-owner-died" },
    );

    const detail = await createAcpxSessionService({ cwd }).getSession({
      acpxRecordId: record.acpxRecordId,
    });
    assert.equal(detail?.ownerState, "absent");
    assert.equal(detail?.turnState, "unknown");
    assert.equal(detail?.activeTurnId, undefined);
  });
});

test("an unreachable owner keeps queue depth visible without guessed turn controls or retirement", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "session-unreachable-queue",
      acpSessionId: "provider-unreachable-queue",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, record);
    await appendSessionTimelineLifecycleEvent(
      record,
      { type: "turn_submitted", prompt_text: "Never infer this target" },
      { turnId: "turn-unproven" },
    );
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, record.acpxRecordId);
    await writeQueueOwnerLock({
      ...paths,
      pid: keeper.pid,
      sessionId: record.acpxRecordId,
      ownerGeneration: 87,
      queueProtocol: QUEUE_PROTOCOL_VERSION,
      queueDepth: 1,
      heartbeatAt: "2000-01-01T00:00:00.000Z",
    });
    const service = createAcpxSessionService({ cwd });
    try {
      const detail = await service.getSession({ acpxRecordId: record.acpxRecordId });
      assert.equal(detail?.ownerState, "unreachable");
      assert.equal(detail?.queue.depth, 1);
      assert.deepEqual(detail?.queue.turns, []);
      await fs.access(paths.lockPath);
      assert.equal(keeper.exitCode, null, "read-only projection retired the unreachable owner");
    } finally {
      service.dispose();
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});

test("an online pre-snapshot owner keeps depth but exposes no guessed turn controls", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "session-legacy-queue-owner",
      acpSessionId: "provider-legacy-queue-owner",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, record);
    await appendSessionTimelineLifecycleEvent(
      record,
      { type: "turn_submitted", prompt_text: "Timeline is not queue authority" },
      { turnId: "turn-unproven" },
    );
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, record.acpxRecordId);
    await writeQueueOwnerLock({
      ...paths,
      pid: keeper.pid,
      sessionId: record.acpxRecordId,
      ownerGeneration: 88,
      queueProtocol: QUEUE_PROTOCOL_PROMPT_QUEUE_SNAPSHOT_VERSION - 1,
      queueDepth: 1,
    });
    const requests: string[] = [];
    const server = createSingleRequestServer((socket, request) => {
      requests.push(request.type);
      assert.equal(request.type, "list_requests");
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      socket.write(
        `${JSON.stringify({
          type: "list_requests_result",
          requestId: request.requestId,
          ownerGeneration: 88,
          requests: [],
        })}\n`,
      );
    });
    await listenServer(server, paths.socketPath);
    const service = createAcpxSessionService({ cwd });
    try {
      const detail = await service.getSession({ acpxRecordId: record.acpxRecordId });
      assert.equal(detail?.ownerState, "online");
      assert.equal(detail?.queue.depth, 1);
      assert.deepEqual(detail?.queue.turns, []);
      assert.deepEqual(requests, ["list_requests"], "sent a v5 verb to a pre-v5 owner");
      await fs.access(paths.lockPath);
      assert.equal(keeper.exitCode, null);
    } finally {
      service.dispose();
      await closeServer(server);
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});

test("a wedged exact-queue snapshot degrades within its read bound without retiring the owner", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "session-wedged-queue-snapshot",
      acpSessionId: "provider-wedged-queue-snapshot",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, record);
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, record.acpxRecordId);
    await writeQueueOwnerLock({
      ...paths,
      pid: keeper.pid,
      sessionId: record.acpxRecordId,
      ownerGeneration: 89,
      queueProtocol: QUEUE_PROTOCOL_VERSION,
      queueDepth: 1,
    });
    const server = createSingleRequestServer((socket, request) => {
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      if (request.type === "list_requests") {
        socket.write(
          `${JSON.stringify({
            type: "list_requests_result",
            requestId: request.requestId,
            ownerGeneration: 89,
            requests: [],
          })}\n`,
        );
        return;
      }
      assert.equal(request.type, "list_prompt_queue");
      // Keep the connection open after acknowledgement: the read-side bound
      // must turn this into an empty exact projection without touching lease state.
    });
    await listenServer(server, paths.socketPath);
    const service = createAcpxSessionService({ cwd });
    const startedAt = Date.now();
    try {
      const detail = await service.getSession({ acpxRecordId: record.acpxRecordId });
      assert.ok(Date.now() - startedAt < 1_000, "snapshot exceeded its bounded read window");
      assert.equal(detail?.ownerState, "online");
      assert.equal(detail?.queue.depth, 1);
      assert.deepEqual(detail?.queue.turns, []);
      await fs.access(paths.lockPath);
      assert.equal(keeper.exitCode, null, "read timeout retired the live owner");
    } finally {
      service.dispose();
      await closeServer(server);
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});

test("a current FIFO snapshot raises queue depth above a stale lease heartbeat", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "session-stale-lease-depth",
      acpSessionId: "provider-stale-lease-depth",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, record);
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, record.acpxRecordId);
    await writeQueueOwnerLock({
      ...paths,
      pid: keeper.pid,
      sessionId: record.acpxRecordId,
      ownerGeneration: 90,
      queueProtocol: QUEUE_PROTOCOL_VERSION,
      queueDepth: 1,
    });
    const prompts = [
      {
        turnId: "turn-new-1",
        submittedAt: "2026-08-13T10:00:00.000Z",
        promptText: "First newly queued prompt",
      },
      {
        turnId: "turn-new-2",
        submittedAt: "2026-08-13T10:00:01.000Z",
        promptText: "Second newly queued prompt",
      },
    ];
    const server = createSingleRequestServer((socket, request) => {
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      if (request.type === "list_requests") {
        socket.write(
          `${JSON.stringify({
            type: "list_requests_result",
            requestId: request.requestId,
            ownerGeneration: 90,
            requests: [],
          })}\n`,
        );
        return;
      }
      assert.equal(request.type, "list_prompt_queue");
      socket.write(
        `${JSON.stringify({
          type: "list_prompt_queue_result",
          requestId: request.requestId,
          ownerGeneration: 90,
          queueDepth: prompts.length,
          omittedCount: 0,
          prompts,
        })}\n`,
      );
    });
    await listenServer(server, paths.socketPath);
    const service = createAcpxSessionService({ cwd });
    try {
      const detail = await service.getSession({ acpxRecordId: record.acpxRecordId });
      assert.equal(detail?.queue.depth, 2);
      assert.deepEqual(detail?.queue.turns, prompts);
    } finally {
      service.dispose();
      await closeServer(server);
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});

test("ambiguous queue transport loss is replayed without a duplicate turn or false failure", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = makeSessionRecord({
      acpxRecordId: "session-ambiguous-admission",
      acpSessionId: "provider-ambiguous-admission",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, initial);
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, initial.acpxRecordId);
    await writeQueueOwnerLock({
      ...paths,
      pid: keeper.pid,
      sessionId: initial.acpxRecordId,
      ownerGeneration: 78,
      queueProtocol: QUEUE_PROTOCOL_VERSION,
      parking: true,
      parkingMaxAgeMs: 86_400_000,
    });
    let submissions = 0;
    const server = createSingleRequestServer((socket, request) => {
      assert.equal(request.type, "submit_prompt");
      submissions += 1;
      socket.write(`${"x".repeat(MAX_MESSAGE_BUFFER_SIZE + 1)}\n`);
    });
    await listenServer(server, paths.socketPath);
    const service = createAcpxSessionService({ cwd });
    const input = {
      acpxRecordId: initial.acpxRecordId,
      prompt: "do this once",
      idempotencyKey: "ambiguous-admission",
    };
    try {
      const first = await service.enqueuePrompt(input);
      assert.equal(first.replayed, true);
      assert.equal(first.result.admission, "unknown");
      const replay = await service.enqueuePrompt(input);
      assert.equal(replay.replayed, true);
      assert.equal(replay.result.admission, "unknown");
      assert.equal(replay.result.turnId, first.result.turnId);
      assert.equal(submissions, 1);

      // A fresh key is explicitly a new user action, not a reconciliation
      // retry. It gets a distinct turn id and may therefore submit again.
      const fresh = await service.enqueuePrompt({
        ...input,
        idempotencyKey: "ambiguous-new-action",
      });
      assert.equal(fresh.result.admission, "unknown");
      assert.notEqual(fresh.result.turnId, first.result.turnId);
      assert.equal(submissions, 2);

      const transcript = await service.getTranscriptPage({
        acpxRecordId: initial.acpxRecordId,
        limit: 20,
      });
      const lifecycleTypes = transcript.items.flatMap((item) =>
        "seq" in item && item.payload.kind === "lifecycle" ? [item.payload.event.type] : [],
      );
      assert.deepEqual(lifecycleTypes, ["turn_submitted", "turn_submitted"]);
    } finally {
      service.dispose();
      await closeServer(server);
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});

test("close reports provider confirmation separately from the durable local close", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = makeSessionRecord({
      acpxRecordId: "session-close-confirmed",
      acpSessionId: "provider-close-confirmed",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, initial);
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, initial.acpxRecordId);
    await writeQueueOwnerLock({
      ...paths,
      pid: keeper.pid,
      sessionId: initial.acpxRecordId,
      ownerGeneration: 91,
      queueProtocol: QUEUE_PROTOCOL_VERSION,
    });
    const server = createSingleRequestServer((socket, request) => {
      assert.equal(request.type, "close_session");
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      socket.write(
        `${JSON.stringify({
          type: "close_session_result",
          requestId: request.requestId,
          closed: true,
        })}\n`,
      );
    });
    await listenServer(server, paths.socketPath);
    const service = createAcpxSessionService({ cwd });
    try {
      const closed = await service.closeSession({
        acpxRecordId: initial.acpxRecordId,
        idempotencyKey: "close-confirmed",
      });
      assert.equal(closed.result.session.sessionState, "closed");
      assert.equal(closed.result.localClose, "closed");
      assert.deepEqual(closed.result.providerClose, { status: "confirmed" });
    } finally {
      service.dispose();
      await closeServer(server);
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});

test("close reports a safe degraded provider result while still closing locally", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = makeSessionRecord({
      acpxRecordId: "session-close-degraded",
      acpSessionId: "provider-close-degraded",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, initial);
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, initial.acpxRecordId);
    await writeQueueOwnerLock({
      ...paths,
      pid: keeper.pid,
      sessionId: initial.acpxRecordId,
      ownerGeneration: 92,
      queueProtocol: QUEUE_PROTOCOL_VERSION,
    });
    const server = createSingleRequestServer((socket, request) => {
      assert.equal(request.type, "close_session");
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      socket.write(`${"x".repeat(MAX_MESSAGE_BUFFER_SIZE + 1)}\n`);
    });
    await listenServer(server, paths.socketPath);
    const service = createAcpxSessionService({ cwd });
    try {
      const closed = await service.closeSession({
        acpxRecordId: initial.acpxRecordId,
        idempotencyKey: "close-degraded",
      });
      assert.equal(closed.result.session.sessionState, "closed");
      assert.equal(closed.result.localClose, "closed");
      assert.deepEqual(closed.result.providerClose, {
        status: "degraded",
        reason: "provider_error",
      });
      assert.equal(JSON.stringify(closed.result).includes("response too large"), false);
    } finally {
      service.dispose();
      await closeServer(server);
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});

test("follow-up prompts are admitted promptly and FIFO while an active turn writer stays open", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = makeSessionRecord({
      acpxRecordId: "session-queue-during-active-turn",
      acpSessionId: "provider-queue-during-active-turn",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, initial);
    const activeWriter = await SessionEventWriter.open(
      await resolveSessionRecord(initial.acpxRecordId),
    );
    await activeWriter.appendLifecycleEvent(
      { type: "turn_started" },
      { turnId: "turn-active", requestId: "turn-active" },
    );

    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, initial.acpxRecordId);
    await writeQueueOwnerLock({
      ...paths,
      pid: keeper.pid,
      sessionId: initial.acpxRecordId,
      ownerGeneration: 82,
      queueProtocol: QUEUE_PROTOCOL_VERSION,
      parking: true,
      parkingMaxAgeMs: 86_400_000,
    });
    const submittedRequestIds: string[] = [];
    const server = createSingleRequestServer((socket, request) => {
      assert.equal(request.type, "submit_prompt");
      submittedRequestIds.push(request.requestId);
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
    });
    await listenServer(server, paths.socketPath);
    const service = createAcpxSessionService({ cwd });

    try {
      const admit = async (prompt: string, idempotencyKey: string) => {
        const enqueue = service.enqueuePrompt({
          acpxRecordId: initial.acpxRecordId,
          prompt,
          idempotencyKey,
        });
        const admitted = await Promise.race([
          enqueue.then((receipt) => ({ prompt: true as const, receipt })),
          new Promise<{ prompt: false }>((resolve) =>
            setTimeout(() => resolve({ prompt: false }), 500),
          ),
        ]);
        if (!admitted.prompt) {
          await activeWriter.close({ checkpoint: true });
          await enqueue;
          assert.fail("queue admission waited for the active turn to finish");
        }
        assert.equal(admitted.receipt.result.admission, "queued");
        return admitted.receipt;
      };

      const first = await admit("first follow-up", "queue-during-active-turn-first");
      const second = await admit("second follow-up", "queue-during-active-turn-second");
      assert.deepEqual(submittedRequestIds, [first.result.turnId, second.result.turnId]);

      await activeWriter.appendLifecycleEvent(
        { type: "turn_completed", stop_reason: "end_turn" },
        { turnId: "turn-active", requestId: "turn-active" },
      );
      await activeWriter.close({ checkpoint: true });

      const transcript = await service.getTranscriptPage({
        acpxRecordId: initial.acpxRecordId,
        limit: 20,
      });
      const lifecycle = transcript.items.flatMap((item) =>
        "seq" in item && item.payload.kind === "lifecycle"
          ? [[item.seq, item.turn_id, item.payload.event.type] as const]
          : [],
      );
      assert.deepEqual(lifecycle, [
        [1, "turn-active", "turn_started"],
        [2, first.result.turnId, "turn_submitted"],
        [3, second.result.turnId, "turn_submitted"],
        [4, "turn-active", "turn_completed"],
      ]);
    } finally {
      await activeWriter.close({ checkpoint: true }).catch(() => undefined);
      service.dispose();
      await closeServer(server);
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});

test("service cancellation uses the CLI queue wire with the exact active turn id", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = makeSessionRecord({
      acpxRecordId: "session-cancel-parity",
      acpSessionId: "provider-cancel-parity",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, initial);
    const record = await resolveSessionRecord(initial.acpxRecordId);
    await appendSessionTimelineLifecycleEvent(
      record,
      { type: "turn_started" },
      { turnId: "turn-exact" },
    );
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, initial.acpxRecordId);
    await writeQueueOwnerLock({
      ...paths,
      pid: keeper.pid,
      sessionId: initial.acpxRecordId,
      ownerGeneration: 79,
      queueProtocol: QUEUE_PROTOCOL_VERSION,
    });
    let targetTurnId: string | undefined;
    const server = createSingleRequestServer((socket, request) => {
      assert.equal(request.type, "cancel_prompt");
      targetTurnId = (request as typeof request & { targetTurnId?: string }).targetTurnId;
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      socket.write(
        `${JSON.stringify({
          type: "cancel_result",
          requestId: request.requestId,
          cancelled: true,
          outcome: "active",
        })}\n`,
      );
    });
    await listenServer(server, paths.socketPath);
    const service = createAcpxSessionService({ cwd });
    try {
      const result = await service.cancelTurn({
        acpxRecordId: initial.acpxRecordId,
        turnId: "turn-exact",
        idempotencyKey: "cancel-exact-parity",
      });
      assert.equal(result.result.state, "cancelling");
      assert.equal(targetTurnId, "turn-exact");
    } finally {
      service.dispose();
      await closeServer(server);
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});

test("ambiguous cancellation is replayed without sending a second cancel", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = makeSessionRecord({
      acpxRecordId: "session-cancel-ambiguous",
      acpSessionId: "provider-cancel-ambiguous",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, initial);
    const record = await resolveSessionRecord(initial.acpxRecordId);
    await appendSessionTimelineLifecycleEvent(
      record,
      { type: "turn_started" },
      { turnId: "turn-ambiguous" },
    );
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, initial.acpxRecordId);
    await writeQueueOwnerLock({
      ...paths,
      pid: keeper.pid,
      sessionId: initial.acpxRecordId,
      ownerGeneration: 81,
      queueProtocol: QUEUE_PROTOCOL_VERSION,
    });
    let cancellations = 0;
    const server = createSingleRequestServer((socket, request) => {
      assert.equal(request.type, "cancel_prompt");
      cancellations += 1;
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      socket.write(`${"x".repeat(MAX_MESSAGE_BUFFER_SIZE + 1)}\n`);
    });
    await listenServer(server, paths.socketPath);
    const service = createAcpxSessionService({ cwd });
    const input = {
      acpxRecordId: initial.acpxRecordId,
      turnId: "turn-ambiguous",
      idempotencyKey: "cancel-ambiguous",
    };

    try {
      await assert.rejects(
        async () => await service.cancelTurn(input),
        (error: unknown) => {
          assert.equal(
            (error as { detailCode?: string }).detailCode,
            "QUEUE_RESPONSE_TOO_LARGE_AFTER_WRITE",
          );
          return true;
        },
      );
      const replay = await service.cancelTurn(input);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, { turnId: "turn-ambiguous", state: "unknown" });
      assert.equal(cancellations, 1);
    } finally {
      service.dispose();
      await closeServer(server);
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});

test("service cancels queued turns exactly and leaves stale ids alone", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = makeSessionRecord({
      acpxRecordId: "session-exact-cancel",
      acpSessionId: "provider-exact-cancel",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, initial);
    const record = await resolveSessionRecord(initial.acpxRecordId);
    await appendSessionTimelineLifecycleEvent(
      record,
      { type: "turn_started" },
      { turnId: "turn-active" },
    );
    await appendSessionTimelineLifecycleEvent(
      record,
      { type: "turn_submitted", prompt_text: "Run this after reload" },
      { turnId: "turn-queued" },
    );
    await appendSessionTimelineLifecycleEvent(
      record,
      { type: "turn_submitted", prompt_text: "Outcome unknown and not in FIFO" },
      { turnId: "turn-newer-unknown" },
    );
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, initial.acpxRecordId);
    await writeQueueOwnerLock({
      ...paths,
      pid: keeper.pid,
      sessionId: initial.acpxRecordId,
      ownerGeneration: 80,
      queueProtocol: QUEUE_PROTOCOL_VERSION,
      // One prompt is pending and one cancellation is still settling. The
      // lease depth remains two, while only the pending prompt gets a control.
      queueDepth: 2,
    });
    const targeted: string[] = [];
    const server = createSingleRequestServer((socket, request) => {
      if (request.type === "list_requests") {
        socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
        socket.write(
          `${JSON.stringify({
            type: "list_requests_result",
            requestId: request.requestId,
            ownerGeneration: 80,
            requests: [],
          })}\n`,
        );
        return;
      }
      if (request.type === "list_prompt_queue") {
        socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
        socket.write(
          `${JSON.stringify({
            type: "list_prompt_queue_result",
            requestId: request.requestId,
            ownerGeneration: 80,
            queueDepth: 2,
            omittedCount: 1,
            prompts: [
              {
                turnId: "turn-queued",
                submittedAt: "2026-08-13T10:00:00.000Z",
                promptText: "Run this after reload",
              },
            ],
          })}\n`,
        );
        return;
      }
      assert.equal(request.type, "cancel_prompt");
      const targetTurnId = (request as typeof request & { targetTurnId?: string }).targetTurnId;
      if (targetTurnId) {
        targeted.push(targetTurnId);
      }
      const outcome = targetTurnId === "turn-queued" ? "queued" : "not_found";
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      socket.write(
        `${JSON.stringify({
          type: "cancel_result",
          requestId: request.requestId,
          cancelled: outcome !== "not_found",
          outcome,
        })}\n`,
      );
    });
    await listenServer(server, paths.socketPath);
    const beforeReload = createAcpxSessionService({ cwd });
    beforeReload.dispose();
    const service = createAcpxSessionService({ cwd });

    try {
      const reloaded = await service.getSession({ acpxRecordId: record.acpxRecordId });
      assert.equal(reloaded?.queue.depth, 2);
      assert.equal(reloaded?.queue.turns.length, 1);
      assert.equal(reloaded?.queue.turns[0]?.turnId, "turn-queued");
      assert.equal(reloaded?.queue.turns[0]?.promptText, "Run this after reload");
      assert.equal(reloaded?.queue.turns[0]?.submittedAt, "2026-08-13T10:00:00.000Z");
      const queued = await service.cancelTurn({
        acpxRecordId: record.acpxRecordId,
        turnId: "turn-queued",
        idempotencyKey: "cancel-queued",
      });
      assert.equal(queued.result.state, "cancelled");

      await assert.rejects(
        async () =>
          await service.cancelTurn({
            acpxRecordId: record.acpxRecordId,
            turnId: "turn-stale",
            idempotencyKey: "cancel-stale",
          }),
        (error: unknown) => {
          assert.ok(error instanceof AcpxTurnNotActiveError);
          assert.match(error.message, /active turn is turn-active/u);
          return true;
        },
      );
      assert.deepEqual(targeted, ["turn-queued", "turn-stale"]);
    } finally {
      service.dispose();
      await closeServer(server);
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});

test("pending permissions and elicitations project without raw tool input", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = makeSessionRecord({
      acpxRecordId: "session-pending-dto",
      acpSessionId: "provider-pending-dto",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, initial);
    const now = "2026-08-12T12:00:00.000Z";
    const common = {
      schema: PENDING_REQUEST_SCHEMA,
      sessionId: initial.acpxRecordId,
      acpSessionId: initial.acpSessionId,
      agentCommand: initial.agentCommand,
      cwd,
      state: "pending",
      createdAt: now,
      updatedAt: now,
      ownerPid: 999_999,
      ownerGeneration: 42,
      taskRequestId: "turn-pending",
    } as const;
    const permission: PendingRequest = {
      ...common,
      kind: "permission",
      requestId: "permission-1",
      toolCall: {
        toolCallId: "tool-1",
        title: "Run checks",
        kind: "execute",
        rawInput: { token: "must-not-leak" },
      },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    };
    const elicitation: PendingRequest = {
      ...common,
      kind: "elicitation",
      requestId: "elicitation-1",
      elicitation: {
        message: "Choose a branch",
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { branch: { type: "string", enum: ["main", "next"] } },
        },
      },
    };
    await writePendingRequest(permission);
    await writePendingRequest(elicitation);

    const service = createAcpxSessionService({ cwd });
    const entries = await service.listPendingRequests({ acpxRecordId: initial.acpxRecordId });
    assert.deepEqual(
      entries.map((entry) => [entry.kind, entry.title]),
      [
        ["elicitation", "Choose a branch"],
        ["permission", "Run checks"],
      ],
    );
    assert.equal(JSON.stringify(entries).includes("must-not-leak"), false);
    assert.deepEqual(entries[0]?.requestedSchema?.properties, {
      branch: { type: "string", enum: ["main", "next"] },
    });
    service.dispose();
  });
});

test("a first pending request on a newly observed session emits an invalidation", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = makeSessionRecord({
      acpxRecordId: "session-first-pending-invalidation",
      acpSessionId: "provider-first-pending-invalidation",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    const now = new Date().toISOString();
    const pending: PendingRequest = {
      schema: PENDING_REQUEST_SCHEMA,
      sessionId: initial.acpxRecordId,
      acpSessionId: initial.acpSessionId,
      agentCommand: initial.agentCommand,
      cwd,
      kind: "permission",
      state: "pending",
      requestId: "first-pending",
      createdAt: now,
      updatedAt: now,
      ownerPid: 999_999,
      ownerGeneration: 81,
      taskRequestId: "turn-first-pending",
      toolCall: { toolCallId: "tool-first", title: "Run checks", kind: "execute" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    };
    const service = createAcpxSessionService({ cwd, timelinePollMs: 100 });
    let unsubscribe = () => {};
    try {
      const invalidated = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("timed out waiting for first pending invalidation")),
          2_000,
        );
        unsubscribe = service.subscribe((event) => {
          if (event.type === "pending" && event.acpxRecordId === initial.acpxRecordId) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      // Let the initial empty poll establish its baseline. The session and its
      // first park then appear in one interval, matching create+prompt races.
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      await writeSessionRecordFile(homeDir, initial);
      await writePendingRequest(pending);
      await invalidated;
    } finally {
      unsubscribe();
      service.dispose();
    }
  });
});

test("subscription polling collapses heartbeat churn but emits owner health transitions", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "session-heartbeat-polling",
      acpSessionId: "provider-heartbeat-polling",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, record);
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, record.acpxRecordId);
    const server = createSingleRequestServer(() => {});
    const createdAt = new Date().toISOString();
    const writeOwner = async (heartbeatAt: string): Promise<void> => {
      await writeQueueOwnerLock({
        ...paths,
        pid: keeper.pid,
        sessionId: record.acpxRecordId,
        ownerGeneration: 72,
        queueDepth: 0,
        createdAt,
        heartbeatAt,
      });
    };
    await writeOwner(createdAt);
    await listenServer(server, paths.socketPath);
    const service = createAcpxSessionService({ cwd, timelinePollMs: 100 });
    const invalidations: string[] = [];
    const unsubscribe = service.subscribe((event) => {
      if (event.type === "session" && event.acpxRecordId === record.acpxRecordId) {
        invalidations.push(event.type);
      }
    });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      assert.equal(
        (await service.getSession({ acpxRecordId: record.acpxRecordId }))?.ownerState,
        "online",
      );

      await writeOwner(new Date().toISOString());
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
      assert.deepEqual(invalidations, [], "fresh heartbeat churn emitted a session invalidation");

      const transitioned = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("timed out waiting for stale-owner invalidation")),
          2_000,
        );
        const observe = service.subscribe((event) => {
          if (event.type === "session" && event.acpxRecordId === record.acpxRecordId) {
            clearTimeout(timeout);
            observe();
            resolve();
          }
        });
      });
      await writeOwner("2000-01-01T00:00:00.000Z");
      await transitioned;
      assert.equal(
        (await service.getSession({ acpxRecordId: record.acpxRecordId }))?.ownerState,
        "unreachable",
      );
    } finally {
      unsubscribe();
      service.dispose();
      await closeServer(server);
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});

test("subscription polling skips closed history and sessions outside its workspace roots", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const workspace = path.join(homeDir, "workspace");
    const outside = path.join(homeDir, "outside");
    await Promise.all([
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(outside, { recursive: true }),
    ]);
    const escapedWorkspace = path.join(workspace, "escaped-workspace");
    await fs.symlink(outside, escapedWorkspace, "dir");
    const active = makeSessionRecord({
      acpxRecordId: "session-subscription-active",
      acpSessionId: "provider-subscription-active",
      agentCommand: AGENT_REGISTRY.codex,
      cwd: workspace,
    });
    const outsideRecord = makeSessionRecord({
      acpxRecordId: "session-subscription-outside",
      acpSessionId: "provider-subscription-outside",
      agentCommand: AGENT_REGISTRY.codex,
      cwd: outside,
    });
    const escapedRecord = makeSessionRecord(
      {
        acpxRecordId: "session-subscription-symlink-escape",
        acpSessionId: "provider-subscription-symlink-escape",
        agentCommand: AGENT_REGISTRY.codex,
        cwd: escapedWorkspace,
      },
      { resolveCwd: false },
    );
    const closed = Array.from({ length: 64 }, (_, index) =>
      makeSessionRecord({
        acpxRecordId: `session-subscription-closed-${String(index).padStart(2, "0")}`,
        acpSessionId: `provider-subscription-closed-${index}`,
        agentCommand: AGENT_REGISTRY.codex,
        cwd: workspace,
        closed: true,
        closedAt: "2026-01-01T00:00:01.000Z",
        lastUsedAt: `2026-01-01T00:00:${String(59 - (index % 60)).padStart(2, "0")}.000Z`,
      }),
    );
    await Promise.all(
      [active, outsideRecord, escapedRecord, ...closed].map(
        async (record) => await writeSessionRecordFile(homeDir, record),
      ),
    );
    // Prime the inventory generation once; the fast subscription poll must use
    // the index rather than re-materializing the retained history thereafter.
    await listStoredSessions();
    assert.deepEqual(
      (await listOpenSessionsForSubscription([workspace])).map((record) => record.acpxRecordId),
      [active.acpxRecordId],
    );

    const service = createAcpxSessionService({
      cwd: workspace,
      subscriptionWorkspaceRoots: [workspace],
      timelinePollMs: 100,
    });
    const invalidations: string[] = [];
    let resolveActive: (() => void) | undefined;
    const activeInvalidated = new Promise<void>((resolve) => {
      resolveActive = resolve;
    });
    const unsubscribe = service.subscribe((event) => {
      if (event.acpxRecordId) {
        invalidations.push(event.acpxRecordId);
      }
      if (event.type === "session" && event.acpxRecordId === active.acpxRecordId) {
        resolveActive?.();
      }
    });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      active.lastUsedAt = "2026-01-02T00:00:00.000Z";
      outsideRecord.lastUsedAt = "2026-01-02T00:00:00.000Z";
      escapedRecord.lastUsedAt = "2026-01-02T00:00:00.000Z";
      for (const record of closed) {
        record.lastUsedAt = "2026-01-02T00:00:00.000Z";
      }
      await Promise.all(
        [active, outsideRecord, escapedRecord, ...closed].map(
          async (record) => await writeSessionRecordFile(homeDir, record),
        ),
      );
      await Promise.race([
        activeInvalidated,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for scoped invalidation")), 2_000),
        ),
      ]);
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      assert.deepEqual([...new Set(invalidations)], [active.acpxRecordId]);
    } finally {
      unsubscribe();
      service.dispose();
    }
  });
});

test("invalidation polling reports background failures and retries", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const acpxPath = path.join(homeDir, ".acpx");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(acpxPath, "blocks session directory creation", "utf8");
    const errors: unknown[] = [];
    let resolveError: (() => void) | undefined;
    const firstError = new Promise<void>((resolve) => {
      resolveError = resolve;
    });
    const service = createAcpxSessionService({
      cwd,
      timelinePollMs: 100,
      onBackgroundError: (error) => {
        errors.push(error);
        resolveError?.();
      },
    });
    let resolveRetry: (() => void) | undefined;
    const retried = new Promise<void>((resolve) => {
      resolveRetry = resolve;
    });
    const unsubscribe = service.subscribe((event) => {
      if (event.type === "session" && event.acpxRecordId === "session-poll-retry") {
        resolveRetry?.();
      }
    });
    try {
      await Promise.race([
        firstError,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for polling failure")), 2_000),
        ),
      ]);
      assert.equal(errors.length, 1);

      await fs.unlink(acpxPath);
      const record = makeSessionRecord({
        acpxRecordId: "session-poll-retry",
        acpSessionId: "provider-poll-retry",
        agentCommand: AGENT_REGISTRY.codex,
        cwd,
      });
      await writeSessionRecordFile(homeDir, record);
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      record.lastUsedAt = new Date(Date.now() + 1_000).toISOString();
      await writeSessionRecordFile(homeDir, record);
      await Promise.race([
        retried,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for polling retry")), 2_000),
        ),
      ]);
      assert.equal(errors.length, 1);
    } finally {
      unsubscribe();
      service.dispose();
    }
  });
});

test("async background error callback rejections are reported without escaping", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const acpxPath = path.join(homeDir, ".acpx");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(acpxPath, "blocks session directory creation", "utf8");
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    let resolveWarning: (() => void) | undefined;
    const warned = new Promise<void>((resolve) => {
      resolveWarning = resolve;
    });
    console.warn = (...values: unknown[]) => {
      warnings.push(values);
      resolveWarning?.();
    };
    const service = createAcpxSessionService({
      cwd,
      onBackgroundError: async () => {
        await Promise.resolve();
        throw new Error("async observer failed");
      },
    });
    const unsubscribe = service.subscribe(() => undefined);
    try {
      await Promise.race([
        warned,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for callback warning")), 2_000),
        ),
      ]);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.[0], "[acpx sessions] background error callback failed");
      assert.match(String(warnings[0]?.[1]), /async observer failed/u);
    } finally {
      unsubscribe();
      service.dispose();
      console.warn = originalWarn;
    }
  });
});

test("pending responses inherit a bounded service timeout when the request omits one", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = makeSessionRecord({
      acpxRecordId: "session-bounded-response",
      acpSessionId: "provider-bounded-response",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, initial);
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, initial.acpxRecordId);
    await writeQueueOwnerLock({
      ...paths,
      pid: keeper.pid,
      sessionId: initial.acpxRecordId,
      ownerGeneration: 77,
    });
    let responseWrites = 0;
    const server = createSingleRequestServer((socket, request) => {
      responseWrites += 1;
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      // Deliberately never send respond_request_result. The service-level default
      // must bound this browser mutation even though the owner accepted it.
    });
    await listenServer(server, paths.socketPath);
    const service = createAcpxSessionService({ cwd, pendingResponseTimeoutMs: 50 });
    const startedAt = Date.now();
    try {
      await assert.rejects(
        async () =>
          await service.respondToPendingRequest({
            acpxRecordId: initial.acpxRecordId,
            requestId: "live-only-request",
            answer: { type: "cancel" },
            idempotencyKey: "bounded-pending-response",
          }),
        (error: unknown) => {
          assert.equal((error as { outputCode?: string }).outputCode, "TIMEOUT");
          assert.equal(
            (error as { detailCode?: string }).detailCode,
            "PENDING_REQUEST_ANSWER_TIMEOUT",
          );
          assert.equal((error as { answerOutcome?: string }).answerOutcome, "unknown");
          return true;
        },
      );
      assert.ok(Date.now() - startedAt < 1_000);

      for (const [idempotencyKey, answer] of [
        ["bounded-pending-response", { type: "cancel" }],
        ["bounded-pending-conflict", { type: "select", option_id: "allow" }],
      ] as const) {
        await assert.rejects(
          async () =>
            await service.respondToPendingRequest({
              acpxRecordId: initial.acpxRecordId,
              requestId: "live-only-request",
              answer,
              idempotencyKey,
            }),
          (error: unknown) => {
            assert.equal((error as { answerOutcome?: string }).answerOutcome, "unknown");
            return true;
          },
        );
      }
      assert.equal(responseWrites, 1, "an ambiguous answer was written to the owner twice");

      const settledAt = new Date().toISOString();
      await writePendingRequest({
        schema: PENDING_REQUEST_SCHEMA,
        kind: "permission",
        requestId: "live-only-request",
        sessionId: initial.acpxRecordId,
        acpSessionId: initial.acpSessionId,
        agentCommand: initial.agentCommand,
        cwd,
        state: "cancelled",
        createdAt: settledAt,
        updatedAt: settledAt,
        ownerPid: keeper.pid!,
        ownerGeneration: 77,
        taskRequestId: "turn-bounded-response",
        toolCall: {
          toolCallId: "tool-bounded-response",
          title: "Bounded response",
          kind: "execute",
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        resolution: { source: "cli", action: "cancel", answeredAt: settledAt },
      });
      const reconciled = await service.respondToPendingRequest({
        acpxRecordId: initial.acpxRecordId,
        requestId: "live-only-request",
        answer: { type: "decline" },
        idempotencyKey: "bounded-pending-reconcile",
      });
      assert.equal(reconciled.result.state, "cancelled");
      assert.equal(reconciled.replayed, true);
      assert.equal(responseWrites, 1, "durable reconciliation resubmitted the answer");
    } finally {
      service.dispose();
      await closeServer(server);
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});

test("an owner-gone response does not reserve the request recovery scope", async () => {
  await withTempHome("acpx-sessions-service-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = makeSessionRecord({
      acpxRecordId: "session-owner-gone-response",
      acpSessionId: "provider-owner-gone-response",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
    });
    await writeSessionRecordFile(homeDir, initial);
    const service = createAcpxSessionService({ cwd, pendingResponseTimeoutMs: 250 });
    const input = {
      acpxRecordId: initial.acpxRecordId,
      requestId: "retryable-request",
      answer: { type: "cancel" } as const,
    };

    try {
      await assert.rejects(
        async () =>
          await service.respondToPendingRequest({
            ...input,
            idempotencyKey: "owner-gone-first",
          }),
        (error: unknown) => {
          assert.equal((error as { detailCode?: string }).detailCode, "PENDING_REQUEST_OWNER_GONE");
          return true;
        },
      );

      const keeper = await startKeeperProcess();
      const paths = queuePaths(homeDir, initial.acpxRecordId);
      await writeQueueOwnerLock({
        ...paths,
        pid: keeper.pid,
        sessionId: initial.acpxRecordId,
        ownerGeneration: 88,
      });
      let responseWrites = 0;
      const server = createSingleRequestServer((socket, request) => {
        responseWrites += 1;
        socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
        // Never confirm the result: unlike the first owner-gone failure, this
        // attempt crossed the owner acknowledgement boundary and is unknown.
      });
      await listenServer(server, paths.socketPath);
      try {
        await assert.rejects(
          async () =>
            await service.respondToPendingRequest({
              ...input,
              idempotencyKey: "owner-gone-second",
            }),
          (error: unknown) => {
            assert.equal(
              (error as { detailCode?: string }).detailCode,
              "PENDING_REQUEST_ANSWER_TIMEOUT",
            );
            assert.equal((error as { answerOutcome?: string }).answerOutcome, "unknown");
            return true;
          },
        );
        assert.equal(responseWrites, 1, "the fresh key must reach the replacement owner");
        await assert.rejects(
          async () =>
            await service.respondToPendingRequest({
              ...input,
              idempotencyKey: "owner-gone-third",
            }),
          (error: unknown) => {
            assert.equal((error as { answerOutcome?: string }).answerOutcome, "unknown");
            return true;
          },
        );
        assert.equal(responseWrites, 1, "post-ack uncertainty must still block another answer");
      } finally {
        await closeServer(server);
        await cleanupOwnerArtifacts(paths);
        stopProcess(keeper);
      }
    } finally {
      service.dispose();
    }
  });
});

for (const scenario of [
  {
    name: "disconnect",
    detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
    finish(socket: Parameters<Parameters<typeof createSingleRequestServer>[0]>[0]): void {
      socket.end();
    },
  },
  {
    name: "malformed completion",
    detailCode: "QUEUE_PROTOCOL_INVALID_JSON",
    finish(socket: Parameters<Parameters<typeof createSingleRequestServer>[0]>[0]): void {
      socket.write('{"type":\n');
    },
  },
] as const) {
  test(`an accepted pending answer with a ${scenario.name} stays scoped as outcome-unknown`, async () => {
    await withTempHome("acpx-sessions-service-", async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });
      const initial = makeSessionRecord({
        acpxRecordId: `session-accepted-${scenario.name.replaceAll(" ", "-")}`,
        acpSessionId: `provider-accepted-${scenario.name.replaceAll(" ", "-")}`,
        agentCommand: AGENT_REGISTRY.codex,
        cwd,
      });
      await writeSessionRecordFile(homeDir, initial);
      const keeper = await startKeeperProcess();
      const paths = queuePaths(homeDir, initial.acpxRecordId);
      await writeQueueOwnerLock({
        ...paths,
        pid: keeper.pid,
        sessionId: initial.acpxRecordId,
        ownerGeneration: 89,
      });
      let responseWrites = 0;
      const server = createSingleRequestServer((socket, request) => {
        responseWrites += 1;
        socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
        scenario.finish(socket);
      });
      await listenServer(server, paths.socketPath);
      const service = createAcpxSessionService({ cwd, pendingResponseTimeoutMs: 1_000 });
      const input = {
        acpxRecordId: initial.acpxRecordId,
        requestId: `request-${scenario.name.replaceAll(" ", "-")}`,
      };
      try {
        await assert.rejects(
          async () =>
            await service.respondToPendingRequest({
              ...input,
              answer: { type: "cancel" },
              idempotencyKey: `accepted-${scenario.name}-first`,
            }),
          (error: unknown) => {
            assert.equal((error as { detailCode?: string }).detailCode, scenario.detailCode);
            return true;
          },
        );
        await assert.rejects(
          async () =>
            await service.respondToPendingRequest({
              ...input,
              answer: { type: "select", option_id: "allow" },
              idempotencyKey: `accepted-${scenario.name}-conflict`,
            }),
          (error: unknown) => {
            assert.equal((error as { answerOutcome?: string }).answerOutcome, "unknown");
            return true;
          },
        );
        assert.equal(responseWrites, 1, "a conflicting answer reached the owner after its ack");
      } finally {
        service.dispose();
        await closeServer(server);
        await cleanupOwnerArtifacts(paths);
        stopProcess(keeper);
      }
    });
  });
}

for (const detailCode of ["QUEUE_RESPONSE_TIMEOUT", "QUEUE_CONNECT_TIMEOUT"] as const) {
  test(`an explicit owner rejection preserves the colliding ${detailCode} code`, async () => {
    await withTempHome("acpx-sessions-service-", async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });
      const suffix = detailCode.toLowerCase().replaceAll("_", "-");
      const initial = makeSessionRecord({
        acpxRecordId: `session-accepted-rejection-${suffix}`,
        acpSessionId: `provider-accepted-rejection-${suffix}`,
        agentCommand: AGENT_REGISTRY.codex,
        cwd,
      });
      await writeSessionRecordFile(homeDir, initial);
      const keeper = await startKeeperProcess();
      const paths = queuePaths(homeDir, initial.acpxRecordId);
      await writeQueueOwnerLock({
        ...paths,
        pid: keeper.pid,
        sessionId: initial.acpxRecordId,
        ownerGeneration: 90,
      });
      let responseWrites = 0;
      const server = createSingleRequestServer((socket, request) => {
        responseWrites += 1;
        socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
        socket.write(
          `${JSON.stringify({
            type: "error",
            requestId: request.requestId,
            ownerGeneration: 90,
            code: "USAGE",
            detailCode,
            origin: "queue",
            retryable: false,
            message: "The pending request has already settled",
          })}\n`,
        );
      });
      await listenServer(server, paths.socketPath);
      const service = createAcpxSessionService({ cwd });
      const input = {
        acpxRecordId: initial.acpxRecordId,
        requestId: `request-accepted-rejection-${suffix}`,
        answer: { type: "cancel" } as const,
      };
      try {
        for (const attempt of ["first", "second"]) {
          await assert.rejects(
            async () =>
              await service.respondToPendingRequest({
                ...input,
                idempotencyKey: `accepted-rejection-${suffix}-${attempt}`,
              }),
            (error: unknown) => {
              assert.equal((error as { detailCode?: string }).detailCode, detailCode);
              assert.equal((error as { outputCode?: string }).outputCode, "USAGE");
              return true;
            },
          );
        }
        assert.equal(responseWrites, 2, "an explicit rejection incorrectly reserved the scope");
      } finally {
        service.dispose();
        await closeServer(server);
        await cleanupOwnerArtifacts(paths);
        stopProcess(keeper);
      }
    });
  });
}
