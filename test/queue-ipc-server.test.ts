import assert from "node:assert/strict";
import readline from "node:readline";
import test from "node:test";
import {
  SessionQueueOwner,
  releaseQueueOwnerLease,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/ipc.js";
import { QUEUE_PROMPT_PREVIEW_MAX_BYTES } from "../src/cli/queue/messages.js";
import { PendingRequestNotAnswerableError } from "../src/errors.js";
import { PENDING_REQUEST_SCHEMA, type PendingRequest } from "../src/session/pending-requests.js";
import {
  connectSocket,
  nextJsonLine,
  noParkedRequestControlHandlers,
  withTempHome,
} from "./queue-test-helpers.js";

test("SessionQueueOwner handles control requests and nextTask timeouts", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-control-success");
    assert(lease);

    let cancelled = 0;
    let closeSessionCalls = 0;
    const modes: string[] = [];
    const configRequests: Array<{ id: string; value: string }> = [];

    const owner = await SessionQueueOwner.start(lease, {
      ...noParkedRequestControlHandlers,
      cancelPrompt: async () => {
        cancelled += 1;
        return true;
      },
      closeSession: async () => {
        closeSessionCalls += 1;
        return true;
      },
      setSessionMode: async (modeId) => {
        modes.push(modeId);
      },
      setSessionModel: async () => {
        // no-op
      },
      setSessionConfigOption: async (configId, value) => {
        configRequests.push({ id: configId, value });
        return {
          configOptions: [],
        };
      },
    });

    try {
      assert.equal(await owner.nextTask(10), undefined);

      const cancelSocket = await connectSocket(lease.socketPath);
      const cancelLines = readline.createInterface({ input: cancelSocket });
      const cancelIterator = cancelLines[Symbol.asyncIterator]();
      cancelSocket.write(
        `${JSON.stringify({
          type: "cancel_prompt",
          requestId: "req-cancel",
        })}\n`,
      );

      const cancelAccepted = (await nextJsonLine(cancelIterator)) as { type: string };
      const cancelResult = (await nextJsonLine(cancelIterator)) as {
        type: string;
        cancelled: boolean;
      };
      assert.equal(cancelAccepted.type, "accepted");
      assert.equal(cancelResult.type, "cancel_result");
      assert.equal(cancelResult.cancelled, true);
      cancelLines.close();
      cancelSocket.destroy();

      const modeSocket = await connectSocket(lease.socketPath);
      const modeLines = readline.createInterface({ input: modeSocket });
      const modeIterator = modeLines[Symbol.asyncIterator]();
      modeSocket.write(
        `${JSON.stringify({
          type: "set_mode",
          requestId: "req-mode",
          modeId: "plan",
          timeoutMs: 250,
        })}\n`,
      );

      const modeAccepted = (await nextJsonLine(modeIterator)) as { type: string };
      const modeResult = (await nextJsonLine(modeIterator)) as { type: string; modeId: string };
      assert.equal(modeAccepted.type, "accepted");
      assert.equal(modeResult.type, "set_mode_result");
      assert.equal(modeResult.modeId, "plan");
      modeLines.close();
      modeSocket.destroy();

      const configSocket = await connectSocket(lease.socketPath);
      const configLines = readline.createInterface({ input: configSocket });
      const configIterator = configLines[Symbol.asyncIterator]();
      configSocket.write(
        `${JSON.stringify({
          type: "set_config_option",
          requestId: "req-config",
          configId: "thinking_level",
          value: "high",
          timeoutMs: 250,
        })}\n`,
      );

      const configAccepted = (await nextJsonLine(configIterator)) as { type: string };
      const configResult = (await nextJsonLine(configIterator)) as {
        type: string;
        response: { configOptions: unknown[] };
      };
      assert.equal(configAccepted.type, "accepted");
      assert.equal(configResult.type, "set_config_option_result");
      assert.deepEqual(configResult.response.configOptions, []);
      configLines.close();
      configSocket.destroy();

      const closeSocket = await connectSocket(lease.socketPath);
      const closeLines = readline.createInterface({ input: closeSocket });
      const closeIterator = closeLines[Symbol.asyncIterator]();
      closeSocket.write(
        `${JSON.stringify({
          type: "close_session",
          requestId: "req-close-session",
          timeoutMs: 250,
        })}\n`,
      );

      const closeAccepted = (await nextJsonLine(closeIterator)) as { type: string };
      const closeResult = (await nextJsonLine(closeIterator)) as {
        type: string;
        closed: boolean;
      };
      assert.equal(closeAccepted.type, "accepted");
      assert.equal(closeResult.type, "close_session_result");
      assert.equal(closeResult.closed, true);
      closeLines.close();
      closeSocket.destroy();

      assert.equal(cancelled, 1);
      assert.equal(closeSessionCalls, 1);
      assert.deepEqual(modes, ["plan"]);
      assert.deepEqual(configRequests, [{ id: "thinking_level", value: "high" }]);
    } finally {
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("SessionQueueOwner enqueues fire-and-forget prompts and rejects invalid owner generations", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-prompt-success");
    assert(lease);

    const queueDepths: number[] = [];
    const owner = await SessionQueueOwner.start(
      lease,
      {
        ...noParkedRequestControlHandlers,
        cancelPrompt: async () => false,
        closeSession: async () => false,
        setSessionMode: async () => {
          // no-op
        },
        setSessionModel: async () => {
          // no-op
        },
        setSessionConfigOption: async () => ({
          configOptions: [],
        }),
      },
      {
        maxQueueDepth: 4,
        onQueueDepthChanged: (depth) => {
          queueDepths.push(depth);
        },
      },
    );

    try {
      const promptSocket = await connectSocket(lease.socketPath);
      const promptLines = readline.createInterface({ input: promptSocket });
      const promptIterator = promptLines[Symbol.asyncIterator]();
      promptSocket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: "req-submit",
          ownerGeneration: lease.ownerGeneration,
          message: "hello from queue",
          permissionMode: "approve-reads",
          waitForCompletion: false,
        })}\n`,
      );

      const accepted = (await nextJsonLine(promptIterator)) as {
        type: string;
        ownerGeneration?: number;
      };
      assert.equal(accepted.type, "accepted");
      assert.equal(accepted.ownerGeneration, lease.ownerGeneration);

      const task = await owner.nextTask();
      assert(task);
      assert.equal(task.requestId, "req-submit");
      assert.equal(task.message, "hello from queue");
      assert.deepEqual(task.prompt, [{ type: "text", text: "hello from queue" }]);
      assert.equal(owner.queueDepth(), 0);
      assert.deepEqual(queueDepths, [1, 0]);
      promptLines.close();
      promptSocket.destroy();

      const badSocket = await connectSocket(lease.socketPath);
      const badLines = readline.createInterface({ input: badSocket });
      const badIterator = badLines[Symbol.asyncIterator]();
      badSocket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: "req-bad-generation",
          ownerGeneration: lease.ownerGeneration + 1,
          message: "stale",
          permissionMode: "approve-reads",
          waitForCompletion: true,
        })}\n`,
      );

      const mismatch = (await nextJsonLine(badIterator)) as {
        type: string;
        detailCode?: string;
      };
      assert.equal(mismatch.type, "error");
      assert.equal(mismatch.detailCode, "QUEUE_OWNER_GENERATION_MISMATCH");
      badLines.close();
      badSocket.destroy();

      const invalidSocket = await connectSocket(lease.socketPath);
      const invalidLines = readline.createInterface({ input: invalidSocket });
      const invalidIterator = invalidLines[Symbol.asyncIterator]();
      invalidSocket.write(
        `${JSON.stringify({
          type: "set_mode",
          requestId: "req-invalid",
          modeId: "",
        })}\n`,
      );

      const invalid = (await nextJsonLine(invalidIterator)) as {
        type: string;
        detailCode?: string;
      };
      assert.equal(invalid.type, "error");
      assert.equal(invalid.detailCode, "QUEUE_REQUEST_INVALID");
      invalidLines.close();
      invalidSocket.destroy();
    } finally {
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("SessionQueueOwner serves the parked-request verbs in the persisted wire shape", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-pending-requests");
    assert(lease);

    const parked: PendingRequest = {
      schema: PENDING_REQUEST_SCHEMA,
      requestId: "pending-1",
      sessionId: "owner-pending-requests",
      acpSessionId: "acp-1",
      agentCommand: "node ./test/mock-agent.js",
      cwd: "/workspace",
      kind: "permission",
      state: "pending",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
      ownerPid: 4242,
      ownerGeneration: lease.ownerGeneration,
      taskRequestId: "task-1",
      toolCall: { toolCallId: "tool-1", title: "Bash: pnpm test", kind: "execute" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    };
    const answers: Array<{ pendingRequestId: string; answer: unknown }> = [];

    const owner = await SessionQueueOwner.start(lease, {
      cancelPrompt: async () => false,
      cancelQueuedPrompt: async () => {},
      closeSession: async () => false,
      setSessionMode: async () => {
        // no-op
      },
      setSessionModel: async () => {
        // no-op
      },
      setSessionConfigOption: async () => ({ configOptions: [] }),
      listPendingRequests: async () => [parked],
      respondToPendingRequest: async (pendingRequestId, answer) => {
        answers.push({ pendingRequestId, answer });
        if (pendingRequestId !== parked.requestId) {
          throw new PendingRequestNotAnswerableError(
            `No pending request ${pendingRequestId} is awaiting an answer on this session`,
          );
        }
        return {
          ...parked,
          state: "answered",
          resolution: {
            answeredAt: "2026-08-12T00:05:00.000Z",
            source: "cli",
            optionId: "allow",
          },
        };
      },
    });

    try {
      const listed = (await sendQueueRequest(lease.socketPath, {
        type: "list_requests",
        requestId: "req-list",
      })) as { type: string; requests: Array<Record<string, unknown>> };
      assert.equal(listed.type, "list_requests_result");
      // Parked requests cross the wire exactly as they are stored, so a reader
      // needs one contract rather than two.
      assert.equal(listed.requests[0]?.schema, PENDING_REQUEST_SCHEMA);
      assert.equal(listed.requests[0]?.request_id, "pending-1");
      assert.equal(listed.requests[0]?.requestId, undefined);
      const listedOptions = listed.requests[0]?.options as Array<{ option_id: string }>;
      assert.equal(listedOptions[0]?.option_id, "allow");

      const answered = (await sendQueueRequest(lease.socketPath, {
        type: "respond_request",
        requestId: "req-respond",
        pendingRequestId: "pending-1",
        answer: { type: "select", option_id: "allow" },
      })) as { type: string; request: Record<string, unknown> };
      assert.equal(answered.type, "respond_request_result");
      assert.equal(answered.request.state, "answered");
      assert.deepEqual(answers, [
        { pendingRequestId: "pending-1", answer: { type: "select", option_id: "allow" } },
      ]);

      const failed = (await sendQueueRequest(lease.socketPath, {
        type: "respond_request",
        requestId: "req-respond-unknown",
        pendingRequestId: "no-such-request",
        answer: { type: "cancel" },
      })) as { type: string; code: string; detailCode: string };
      // The typed USAGE code has to survive the wire or the CLI cannot map an
      // unanswerable request onto exit code 2.
      assert.equal(failed.type, "error");
      assert.equal(failed.code, "USAGE");
      assert.equal(failed.detailCode, "PENDING_REQUEST_NOT_ANSWERABLE");
    } finally {
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("SessionQueueOwner cancels exactly one queued prompt and preserves FIFO order", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-cancel-queued");
    assert(lease);

    const cancelledQueued: string[] = [];
    let activeCancelCalls = 0;
    const handlers = {
      ...noParkedRequestControlHandlers,
      cancelQueuedPrompt: async (turnId: string) => {
        cancelledQueued.push(turnId);
      },
      cancelPrompt: async () => {
        activeCancelCalls += 1;
        return false;
      },
      closeSession: async () => false,
      setSessionMode: async () => {},
      setSessionModel: async (): Promise<undefined> => undefined,
      setSessionConfigOption: async () => ({ configOptions: [] }),
    };
    const owner = await SessionQueueOwner.start(lease, handlers, { maxQueueDepth: 4 });

    try {
      await enqueuePrompt(lease.socketPath, "turn-a", false);
      await enqueuePrompt(lease.socketPath, "turn-b", false);
      await enqueuePrompt(lease.socketPath, "turn-c", false);

      const result = (await sendQueueRequest(lease.socketPath, {
        type: "cancel_prompt",
        requestId: "cancel-b",
        ownerGeneration: lease.ownerGeneration,
        targetTurnId: "turn-b",
      })) as { type: string; cancelled: boolean; outcome?: string };

      assert.deepEqual(result, {
        type: "cancel_result",
        requestId: "cancel-b",
        ownerGeneration: lease.ownerGeneration,
        cancelled: true,
        outcome: "queued",
      });
      assert.deepEqual(cancelledQueued, ["turn-b"]);
      assert.equal(activeCancelCalls, 0);
      assert.equal(owner.queueDepth(), 2);

      const missing = (await sendQueueRequest(lease.socketPath, {
        type: "cancel_prompt",
        requestId: "cancel-missing",
        ownerGeneration: lease.ownerGeneration,
        targetTurnId: "turn-missing",
      })) as { type: string; cancelled: boolean; outcome?: string };
      assert.equal(missing.cancelled, false);
      assert.equal(missing.outcome, "not_found");
      assert.equal(activeCancelCalls, 1);
      assert.equal(owner.queueDepth(), 2);
      assert.equal((await owner.nextTask())?.requestId, "turn-a");
      assert.equal((await owner.nextTask())?.requestId, "turn-c");
    } finally {
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("SessionQueueOwner snapshots mixed prompt sources exactly and a new owner starts empty", async () => {
  await withTempHome(async () => {
    const sessionId = "owner-list-prompt-queue";
    const handlers = {
      ...noParkedRequestControlHandlers,
      cancelPrompt: async () => false,
      closeSession: async () => false,
      setSessionMode: async () => {},
      setSessionModel: async (): Promise<undefined> => undefined,
      setSessionConfigOption: async () => ({ configOptions: [] }),
    };
    const firstLease = await tryAcquireQueueOwnerLease(sessionId);
    assert(firstLease);
    const firstOwner = await SessionQueueOwner.start(firstLease, handlers, { maxQueueDepth: 4 });

    try {
      await enqueuePrompt(firstLease.socketPath, "turn-cli", false, "ordinary CLI prompt");
      await enqueuePrompt(firstLease.socketPath, "turn-service", false, "service prompt");
      await enqueuePrompt(
        firstLease.socketPath,
        "turn-large",
        false,
        `large-${"🙂".repeat(QUEUE_PROMPT_PREVIEW_MAX_BYTES)}`,
      );
      const snapshot = (await sendQueueRequest(firstLease.socketPath, {
        type: "list_prompt_queue",
        requestId: "list-mixed",
        ownerGeneration: firstLease.ownerGeneration,
      })) as {
        type: string;
        ownerGeneration?: number;
        queueDepth: number;
        omittedCount: number;
        prompts: Array<{
          turnId: string;
          submittedAt: string;
          promptText: string;
          promptTruncated?: true;
        }>;
      };
      assert.equal(snapshot.type, "list_prompt_queue_result");
      assert.equal(snapshot.ownerGeneration, firstLease.ownerGeneration);
      assert.equal(snapshot.queueDepth, 3);
      assert.equal(snapshot.omittedCount, 0);
      assert.deepEqual(
        snapshot.prompts.slice(0, 2).map(({ turnId, promptText }) => ({ turnId, promptText })),
        [
          { turnId: "turn-cli", promptText: "ordinary CLI prompt" },
          { turnId: "turn-service", promptText: "service prompt" },
        ],
      );
      assert.equal(snapshot.prompts[2]?.turnId, "turn-large");
      assert.equal(snapshot.prompts[2]?.promptTruncated, true);
      assert.equal(snapshot.prompts[2]?.promptText.endsWith("…"), true);
      assert.ok(
        Buffer.byteLength(snapshot.prompts[2]?.promptText ?? "", "utf8") <=
          QUEUE_PROMPT_PREVIEW_MAX_BYTES,
      );
      assert.equal(
        snapshot.prompts.every(({ submittedAt }) => !Number.isNaN(Date.parse(submittedAt))),
        true,
      );
    } finally {
      await firstOwner.close();
      await releaseQueueOwnerLease(firstLease);
    }

    const secondLease = await tryAcquireQueueOwnerLease(sessionId);
    assert(secondLease);
    assert.notEqual(secondLease.ownerGeneration, firstLease.ownerGeneration);
    const secondOwner = await SessionQueueOwner.start(secondLease, handlers, { maxQueueDepth: 4 });
    try {
      const restarted = (await sendQueueRequest(secondLease.socketPath, {
        type: "list_prompt_queue",
        requestId: "list-restarted",
        ownerGeneration: secondLease.ownerGeneration,
      })) as { type: string; queueDepth: number; omittedCount: number; prompts: unknown[] };
      assert.equal(restarted.type, "list_prompt_queue_result");
      assert.equal(restarted.queueDepth, 0);
      assert.equal(restarted.omittedCount, 0);
      assert.deepEqual(restarted.prompts, []);
    } finally {
      await secondOwner.close();
      await releaseQueueOwnerLease(secondLease);
    }
  });
});

test("SessionQueueOwner restores a queued prompt when durable cancellation fails", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-cancel-queued-fails");
    assert(lease);

    const handlers = {
      ...noParkedRequestControlHandlers,
      cancelQueuedPrompt: async (turnId: string) => {
        if (turnId === "turn-b") {
          throw new Error("timeline unavailable");
        }
      },
      cancelPrompt: async () => false,
      closeSession: async () => false,
      setSessionMode: async () => {},
      setSessionModel: async (): Promise<undefined> => undefined,
      setSessionConfigOption: async () => ({ configOptions: [] }),
    };
    const owner = await SessionQueueOwner.start(lease, handlers, { maxQueueDepth: 4 });

    try {
      await enqueuePrompt(lease.socketPath, "turn-a", false);
      await enqueuePrompt(lease.socketPath, "turn-b", false);
      await enqueuePrompt(lease.socketPath, "turn-c", false);

      const result = (await sendQueueRequest(lease.socketPath, {
        type: "cancel_prompt",
        requestId: "cancel-b-fails",
        ownerGeneration: lease.ownerGeneration,
        targetTurnId: "turn-b",
      })) as { type: string; detailCode?: string; message?: string };

      assert.equal(result.type, "error");
      assert.equal(result.detailCode, "QUEUE_CONTROL_REQUEST_FAILED");
      assert.match(result.message ?? "", /timeline unavailable/);
      assert.equal(owner.queueDepth(), 3);
      assert.equal((await owner.nextTask())?.requestId, "turn-a");
      assert.equal((await owner.nextTask())?.requestId, "turn-b");
      assert.equal((await owner.nextTask())?.requestId, "turn-c");
    } finally {
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("SessionQueueOwner tells a waiting queued caller when its prompt is cancelled", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-cancel-queued-waiting");
    assert(lease);

    const handlers = {
      ...noParkedRequestControlHandlers,
      cancelQueuedPrompt: async () => {},
      cancelPrompt: async () => false,
      closeSession: async () => false,
      setSessionMode: async () => {},
      setSessionModel: async (): Promise<undefined> => undefined,
      setSessionConfigOption: async () => ({ configOptions: [] }),
    };
    const owner = await SessionQueueOwner.start(lease, handlers, { maxQueueDepth: 4 });
    const taskSocket = await connectSocket(lease.socketPath);
    const taskLines = readline.createInterface({ input: taskSocket });
    const taskIterator = taskLines[Symbol.asyncIterator]();

    try {
      taskSocket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: "turn-waiting",
          ownerGeneration: lease.ownerGeneration,
          message: "wait for me",
          permissionMode: "approve-reads",
          waitForCompletion: true,
        })}\n`,
      );
      assert.equal(((await nextJsonLine(taskIterator)) as { type: string }).type, "accepted");

      const result = (await sendQueueRequest(lease.socketPath, {
        type: "cancel_prompt",
        requestId: "cancel-waiting",
        ownerGeneration: lease.ownerGeneration,
        targetTurnId: "turn-waiting",
      })) as { type: string; outcome?: string };
      assert.equal(result.type, "cancel_result");
      assert.equal(result.outcome, "queued");

      const cancelled = (await nextJsonLine(taskIterator)) as {
        type: string;
        detailCode?: string;
        retryable?: boolean;
      };
      assert.equal(cancelled.type, "error");
      assert.equal(cancelled.detailCode, "QUEUE_PROMPT_CANCELLED");
      assert.equal(cancelled.retryable, false);
      assert.equal(owner.queueDepth(), 0);
    } finally {
      taskLines.close();
      taskSocket.destroy();
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});

async function enqueuePrompt(
  socketPath: string,
  requestId: string,
  waitForCompletion: boolean,
  message = requestId,
): Promise<void> {
  const socket = await connectSocket(socketPath);
  const lines = readline.createInterface({ input: socket });
  const iterator = lines[Symbol.asyncIterator]();
  try {
    socket.write(
      `${JSON.stringify({
        type: "submit_prompt",
        requestId,
        message,
        permissionMode: "approve-reads",
        waitForCompletion,
      })}\n`,
    );
    assert.equal(((await nextJsonLine(iterator)) as { type: string }).type, "accepted");
  } finally {
    lines.close();
    socket.destroy();
  }
}

async function sendQueueRequest(socketPath: string, request: unknown): Promise<unknown> {
  const socket = await connectSocket(socketPath);
  const lines = readline.createInterface({ input: socket });
  const iterator = lines[Symbol.asyncIterator]();
  try {
    socket.write(`${JSON.stringify(request)}\n`);
    const accepted = (await nextJsonLine(iterator)) as { type: string };
    assert.equal(accepted.type, "accepted");
    return await nextJsonLine(iterator);
  } finally {
    lines.close();
    socket.destroy();
  }
}
