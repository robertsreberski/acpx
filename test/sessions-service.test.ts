import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { MAX_MESSAGE_BUFFER_SIZE } from "../src/cli/queue/ipc.js";
import {
  PENDING_REQUEST_SCHEMA,
  writePendingRequest,
  type PendingRequest,
} from "../src/session/pending-requests.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import { appendSessionTimelineLifecycleEvent } from "../src/session/timeline.js";
import { AcpxTurnNotActiveError, createAcpxSessionService } from "../src/sessions.js";
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
      queueProtocol: 3,
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
      await assert.rejects(
        async () => await service.enqueuePrompt(input),
        (error: unknown) => {
          assert.equal(
            (error as { detailCode?: string }).detailCode,
            "QUEUE_RESPONSE_TOO_LARGE_AFTER_WRITE",
          );
          return true;
        },
      );
      const replay = await service.enqueuePrompt(input);
      assert.equal(replay.replayed, true);
      assert.equal(replay.result.admission, "unknown");
      assert.equal(submissions, 1);

      const transcript = await service.getTranscriptPage({
        acpxRecordId: initial.acpxRecordId,
        limit: 20,
      });
      const lifecycleTypes = transcript.items.flatMap((item) =>
        "seq" in item && item.payload.kind === "lifecycle" ? [item.payload.event.type] : [],
      );
      assert.deepEqual(lifecycleTypes, ["turn_submitted"]);
    } finally {
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
      queueProtocol: 3,
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

test("queued and stale turn ids cannot cancel the active turn", async () => {
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
      { type: "turn_submitted" },
      { turnId: "turn-queued" },
    );
    const service = createAcpxSessionService({ cwd });

    for (const [turnId, key] of [
      ["turn-queued", "cancel-queued"],
      ["turn-stale", "cancel-stale"],
    ] as const) {
      await assert.rejects(
        async () =>
          await service.cancelTurn({
            acpxRecordId: record.acpxRecordId,
            turnId,
            idempotencyKey: key,
          }),
        (error: unknown) => {
          assert.ok(error instanceof AcpxTurnNotActiveError);
          assert.match(error.message, /active turn is turn-active/u);
          return true;
        },
      );
    }
    service.dispose();
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
    const server = createSingleRequestServer((socket, request) => {
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
          return true;
        },
      );
      assert.ok(Date.now() - startedAt < 1_000);
    } finally {
      service.dispose();
      await closeServer(server);
      await cleanupOwnerArtifacts(paths);
      stopProcess(keeper);
    }
  });
});
