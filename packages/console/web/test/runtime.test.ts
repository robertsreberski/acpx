import assert from "node:assert/strict";
import test from "node:test";
import { convertTimelineMessage } from "../src/runtime";

test("agent activity is projected as an assistant tool call even when its source role is user", () => {
  const message = convertTimelineMessage({
    event: {
      id: "event-1",
      sequence: 1,
      occurredAt: "2026-08-13T12:00:00.000Z",
      kind: "tool_call",
      role: "user",
      status: "running",
      title: "Run browser QA",
      payload: { sessionUpdate: "tool_call" },
    },
  });

  assert.equal(message.role, "assistant");
  assert.equal(Array.isArray(message.content), true);
  assert.equal(Array.isArray(message.content) && message.content[0]?.type, "tool-call");
});

test("ordinary persisted user text remains a user message", () => {
  const message = convertTimelineMessage({
    event: {
      id: "event-2",
      sequence: 2,
      occurredAt: "2026-08-13T12:00:01.000Z",
      kind: "message",
      role: "user",
      status: "complete",
      text: "hello",
      payload: {},
    },
  });

  assert.equal(message.role, "user");
  assert.equal(Array.isArray(message.content) && message.content[0]?.type, "text");
});
