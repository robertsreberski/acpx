import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { MAX_MESSAGE_BUFFER_SIZE } from "../src/cli/queue/ipc.js";
import { SessionEventWriter } from "../src/session/events.js";
import {
  PENDING_REQUEST_SCHEMA,
  writePendingRequest,
  type PendingRequest,
} from "../src/session/pending-requests.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import { appendSessionTimelineLifecycleEvent } from "../src/session/timeline.js";
import { sessionsServiceTestInternals } from "../src/sessions-service/service.js";
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
      queueProtocol: 3,
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
