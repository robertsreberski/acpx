import assert from "node:assert/strict";
import test from "node:test";
import { convertTimelineMessage } from "../src/runtime";
import {
  projectTimelineEvent,
  timelineEventIsRunning,
  type WireTimelineEvent,
} from "../src/timeline-projector";

const wire = (payload: unknown): WireTimelineEvent => ({
  schema: "acpx.session_event.v1",
  epoch: "epoch-1",
  seq: 1,
  captured_at: "2026-08-12T10:00:01.000Z",
  direction: "inbound",
  turn_id: "turn-1",
  payload,
});

test("projects JSON-RPC error responses as failed activity without losing error details", () => {
  const error = {
    code: -32_070,
    message: "The provider timed out",
    data: {
      acpxCode: "TIMEOUT",
      retryable: true,
      provider: { requestId: "provider-request-1" },
    },
  };
  const projected = projectTimelineEvent(
    wire({
      kind: "acp",
      message: { jsonrpc: "2.0", id: 42, error },
    }),
  );

  assert.equal(projected.kind, "jsonrpc_error");
  assert.equal(projected.title, "ACP request failed");
  assert.equal(projected.text, "The provider timed out");
  assert.equal(projected.status, "failed");
  assert.deepEqual(projected.input, { id: 42 });
  assert.deepEqual(projected.output, error);
  assert.equal(timelineEventIsRunning(projected), false);

  const message = convertTimelineMessage({ event: projected });
  assert.deepEqual(message.status, {
    type: "incomplete",
    reason: "error",
    error: "The provider timed out",
  });
  assert.ok(Array.isArray(message.content));
  const part = message.content[0];
  assert.equal(part?.type, "tool-call");
  assert.equal(part?.type === "tool-call" && part.isError, true);
  assert.deepEqual(part?.type === "tool-call" ? part.result : undefined, error);
});
