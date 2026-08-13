import assert from "node:assert/strict";
import test from "node:test";
import {
  tryListPromptQueueOnRunningOwner,
  tryListRequestsOnRunningOwner,
  tryRespondOnRunningOwner,
} from "../src/cli/queue/ipc.js";
import { QUEUE_PROTOCOL_VERSION } from "../src/cli/queue/lease-store.js";
import { PendingRequestAnswerTimeoutError } from "../src/errors.js";
import {
  cleanupOwnerArtifacts,
  closeServer,
  createSingleRequestServer,
  listenServer,
  queuePaths,
  startKeeperProcess,
  stopProcess,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";

type SessionModule = typeof import("../src/session/session.js");

const SESSION_MODULE_URL = new URL("../src/session/session.js", import.meta.url);

test("cancelSessionPrompt sends cancel request to active queue owner", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const sessionId = "cancel-session";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
    });

    const server = createSingleRequestServer((socket, request) => {
      assert.equal(request.type, "cancel_prompt");
      socket.write(
        `${JSON.stringify({
          type: "accepted",
          requestId: request.requestId,
        })}\n`,
      );
      socket.write(
        `${JSON.stringify({
          type: "cancel_result",
          requestId: request.requestId,
          cancelled: true,
        })}\n`,
      );
      socket.end();
    });

    await listenServer(server, socketPath);

    try {
      const result = await session.cancelSessionPrompt({ sessionId });
      assert.equal(result.cancelled, true);
      assert.equal(result.outcome, "active");
      assert.equal(result.sessionId, sessionId);
    } finally {
      await closeServer(server);
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});

async function loadSessionModule(): Promise<SessionModule> {
  const cacheBuster = `${Date.now()}-${Math.random()}`;
  return (await import(`${SESSION_MODULE_URL.href}?session_test=${cacheBuster}`)) as SessionModule;
}

const STORED_ENTRY = {
  schema: "acpx.pending_request.v1",
  request_id: "pending-1",
  session_id: "requests-session",
  acp_session_id: "acp-1",
  agent_command: "node ./test/mock-agent.js",
  cwd: "/workspace",
  kind: "permission",
  state: "pending",
  created_at: "2026-08-12T00:00:00.000Z",
  updated_at: "2026-08-12T00:00:00.000Z",
  owner_pid: 4242,
  owner_generation: 77,
  task_request_id: "task-1",
  tool_call: { tool_call_id: "tool-1", title: "Bash: pnpm test", kind: "execute" },
  options: [
    { option_id: "allow", name: "Allow", kind: "allow_once" },
    { option_id: "reject", name: "Reject", kind: "reject_once" },
  ],
};

test("tryListRequestsOnRunningOwner parses the parked requests the owner reports", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "requests-session";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
      ownerGeneration: 77,
    });

    const server = createSingleRequestServer((socket, request) => {
      assert.equal(request.type, "list_requests");
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      socket.write(
        `${JSON.stringify({
          type: "list_requests_result",
          requestId: request.requestId,
          ownerGeneration: 77,
          requests: [STORED_ENTRY],
        })}\n`,
      );
      socket.end();
    });
    await listenServer(server, socketPath);

    try {
      const requests = await tryListRequestsOnRunningOwner({ sessionId });
      assert.equal(requests?.length, 1);
      const parked = requests?.[0];
      assert.equal(parked?.requestId, "pending-1");
      assert.equal(parked?.kind, "permission");
      assert.equal(
        parked?.kind === "permission" ? parked.toolCall.toolCallId : undefined,
        "tool-1",
      );
      assert.deepEqual(parked?.kind === "permission" ? parked.options[0] : undefined, {
        optionId: "allow",
        name: "Allow",
        kind: "allow_once",
      });
    } finally {
      await closeServer(server);
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});

test("tryListPromptQueueOnRunningOwner returns only the owner's exact FIFO snapshot", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "prompt-queue-session";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
      ownerGeneration: 78,
      queueProtocol: QUEUE_PROTOCOL_VERSION,
      queueDepth: 2,
    });
    const prompts = [
      {
        turnId: "turn-cli",
        submittedAt: "2026-08-13T10:00:00.000Z",
        promptText: "CLI prompt",
      },
      {
        turnId: "turn-service",
        submittedAt: "2026-08-13T10:00:01.000Z",
        promptText: "Service prompt",
      },
    ];
    const server = createSingleRequestServer((socket, request) => {
      assert.equal(request.type, "list_prompt_queue");
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      socket.write(
        `${JSON.stringify({
          type: "list_prompt_queue_result",
          requestId: request.requestId,
          ownerGeneration: 78,
          prompts,
        })}\n`,
      );
      socket.end();
    });
    await listenServer(server, socketPath);
    try {
      assert.deepEqual(await tryListPromptQueueOnRunningOwner({ sessionId }), {
        ownerGeneration: 78,
        prompts,
      });
    } finally {
      await closeServer(server);
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});

test("prompt queue snapshots fail closed for owners predating the read-only verb", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "legacy-prompt-queue-session";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
      queueProtocol: 4,
      queueDepth: 1,
    });
    try {
      assert.equal(await tryListPromptQueueOnRunningOwner({ sessionId }), undefined);
    } finally {
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});

test("tryRespondOnRunningOwner sends the tagged answer and returns the terminal entry", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "requests-session";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
      ownerGeneration: 77,
    });

    const sent: unknown[] = [];
    const server = createSingleRequestServer((socket, request) => {
      sent.push(request);
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      socket.write(
        `${JSON.stringify({
          type: "respond_request_result",
          requestId: request.requestId,
          ownerGeneration: 77,
          request: {
            ...STORED_ENTRY,
            state: "answered",
            resolution: {
              answered_at: "2026-08-12T00:05:00.000Z",
              source: "cli",
              option_id: "allow",
            },
          },
        })}\n`,
      );
      socket.end();
    });
    await listenServer(server, socketPath);

    try {
      const answered = await tryRespondOnRunningOwner({
        sessionId,
        pendingRequestId: "pending-1",
        answer: { type: "select", option_id: "allow" },
      });

      assert.equal(answered?.state, "answered");
      assert.equal(answered?.resolution?.optionId, "allow");
      assert.deepEqual(
        sent.map((request) => ({
          type: (request as { type: string }).type,
          pendingRequestId: (request as { pendingRequestId: string }).pendingRequestId,
          answer: (request as { answer: unknown }).answer,
          ownerGeneration: (request as { ownerGeneration: number }).ownerGeneration,
        })),
        [
          {
            type: "respond_request",
            pendingRequestId: "pending-1",
            answer: { type: "select", option_id: "allow" },
            ownerGeneration: 77,
          },
        ],
      );
    } finally {
      await closeServer(server);
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});

test("the parked-request client verbs report no owner rather than an empty result", async () => {
  await withTempHome(async () => {
    // No lease at all: "nothing to ask" must stay distinguishable from "the
    // owner says there is nothing parked".
    assert.equal(await tryListRequestsOnRunningOwner({ sessionId: "never-owned" }), undefined);
    assert.equal(await tryListPromptQueueOnRunningOwner({ sessionId: "never-owned" }), undefined);
    assert.equal(
      await tryRespondOnRunningOwner({
        sessionId: "never-owned",
        pendingRequestId: "pending-1",
        answer: { type: "cancel" },
      }),
      undefined,
    );
  });
});

/**
 * A live lease whose socket refuses every connect: the owner process is alive,
 * so the caller gets past the liveness read, and then every connect attempt
 * fails with a retryable error. This is what a wedged owner looks like from the
 * outside — a suspended process whose listen backlog has filled up refuses
 * connects exactly this way.
 */
async function withUnreachableOwner(
  run: (context: { sessionId: string }) => Promise<void>,
): Promise<void> {
  await withTempHome(async (homeDir) => {
    const sessionId = "unreachable-owner";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({ lockPath, pid: keeper.pid, sessionId, socketPath });
    try {
      await run({ sessionId });
    } finally {
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
}

test("an asked-for respond bound covers connecting, not just the reply", async () => {
  await withUnreachableOwner(async ({ sessionId }) => {
    const started = Date.now();
    await assert.rejects(
      async () =>
        await tryRespondOnRunningOwner({
          sessionId,
          pendingRequestId: "pending-1",
          answer: { type: "cancel" },
          responseTimeoutMs: 200,
        }),
      (error: unknown) => {
        // Exit 3 with its own detail code is the whole point of the bound: a
        // caller has to be able to tell "I stopped waiting" from "delivery
        // failed". A connect that outruns the budget must not degrade it.
        assert.equal(error instanceof PendingRequestAnswerTimeoutError, true, String(error));
        return true;
      },
    );
    const elapsedMs = Date.now() - started;
    // The unbounded connect loop is 40 attempts x 50 ms = ~2 s, so anything at
    // or past that is the bound being armed only after the socket is up.
    assert.equal(elapsedMs < 1_500, true, `respond took ${elapsedMs}ms against a 200ms bound`);
  });
});

test("an unbounded respond still reports an unreachable owner instead of a timeout", async () => {
  await withUnreachableOwner(async ({ sessionId }) => {
    // The budget is opt-in. Without one, exhausting the connect retries still
    // means "could not reach the owner", which is a different answer than
    // "you told me to stop waiting" and keeps its own exit code.
    await assert.rejects(
      async () =>
        await tryRespondOnRunningOwner({
          sessionId,
          pendingRequestId: "pending-1",
          answer: { type: "cancel" },
        }),
      (error: unknown) => {
        assert.equal(error instanceof PendingRequestAnswerTimeoutError, false, String(error));
        return true;
      },
    );
  });
});
