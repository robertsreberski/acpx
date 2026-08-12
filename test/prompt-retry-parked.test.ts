import assert from "node:assert/strict";
import test from "node:test";
import type { PendingRequestEvent } from "../src/cli/queue/pending-request-manager.js";
import { sessionRuntimeTestInternals } from "../src/cli/session/runtime.js";
import type { AcpJsonRpcMessage, OutputFormatter } from "../src/types.js";

const { shouldRetryRuntimePrompt, createPendingRequestSink } = sessionRuntimeTestInternals;

/** A retryable ACP failure: the kind a prompt retry exists for. */
const RETRYABLE_ERROR = Object.assign(new Error("internal"), { code: -32603 });

function cleanSnapshot(): Parameters<typeof shouldRetryRuntimePrompt>[3] {
  return {} as Parameters<typeof shouldRetryRuntimePrompt>[3];
}

test("a turn that produced side effects is never retried", () => {
  assert.equal(
    shouldRetryRuntimePrompt(RETRYABLE_ERROR, 0, 3, cleanSnapshot(), () => false),
    true,
    "a clean turn with a retryable error is the case retries exist for",
  );
  // Retrying re-runs the whole prompt, so anything the turn already did to the
  // outside world would happen twice.
  assert.equal(
    shouldRetryRuntimePrompt(RETRYABLE_ERROR, 0, 3, cleanSnapshot(), () => true),
    false,
  );
});

function parkEvent(event: PendingRequestEvent["event"]): PendingRequestEvent {
  return {
    type: "pending_request",
    event,
    request: {
      schema: "acpx.pending_request.v1",
      requestId: "req-1",
      sessionId: "session-1",
      acpSessionId: "acp-1",
      agentCommand: "node ./test/mock-agent.js",
      cwd: "/workspace",
      kind: "permission",
      state: event === "created" ? "pending" : "answered",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
      ownerPid: 1,
      ownerGeneration: 1,
      taskRequestId: "task-1",
      toolCall: { toolCallId: "tool-1", title: "Bash", rawInput: { command: "ls" } },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    },
  };
}

test("parking a request counts as a side effect, so the turn is never retried", () => {
  // A park writes a durable record an operator can see and answer. Re-running
  // the turn would ask a second time, and the first request would still be
  // sitting there — so a parked turn must be out of the retry path even when
  // nothing else about it looks like a side effect yet.
  for (const event of ["created", "answered", "expired", "cancelled", "orphaned"] as const) {
    let marked = false;
    const messages: AcpJsonRpcMessage[] = [];
    const sink = createPendingRequestSink({
      output: { onAcpMessage: () => {} } as unknown as OutputFormatter,
      pendingMessages: messages,
      markSideEffect: () => {
        marked = true;
      },
    });

    sink(parkEvent(event));

    assert.equal(marked, true, `${event} did not mark the turn`);
    assert.equal(messages.length, 1, event);
    assert.equal((messages[0] as { method?: string }).method, "_acpx/pending_request", event);
    assert.equal(
      shouldRetryRuntimePrompt(RETRYABLE_ERROR, 0, 3, cleanSnapshot(), () => marked),
      false,
      event,
    );
  }
});
