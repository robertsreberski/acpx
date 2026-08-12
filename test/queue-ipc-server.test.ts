import assert from "node:assert/strict";
import readline from "node:readline";
import test from "node:test";
import {
  SessionQueueOwner,
  releaseQueueOwnerLease,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/ipc.js";
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
