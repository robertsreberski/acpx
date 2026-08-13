import assert from "node:assert/strict";
import test from "node:test";
import { conversationEvents, isConversationEvent } from "../src/transcript-visibility";
import type { TranscriptEvent } from "../src/types";

const event = (kind: string, overrides: Partial<TranscriptEvent> = {}): TranscriptEvent => ({
  id: `event-${kind}`,
  sequence: 1,
  occurredAt: "2026-08-13T12:00:00.000Z",
  kind,
  ...overrides,
});

test("the conversation keeps what the agent said and did", () => {
  for (const kind of ["message", "text", "reasoning", "plan", "tool_call"]) {
    assert.equal(isConversationEvent(event(kind)), true, kind);
  }
});

test("requests stay visible so a stalled turn is explainable", () => {
  assert.equal(isConversationEvent(event("permission")), true);
  assert.equal(isConversationEvent(event("elicitation")), true);
});

test("failures and truncation are not transport noise", () => {
  assert.equal(isConversationEvent(event("jsonrpc_error")), true);
  assert.equal(isConversationEvent(event("timeline_truncated")), true);
  assert.equal(isConversationEvent(event("history_gap")), true);
});

test("protocol traffic stays out of the transcript", () => {
  for (const kind of [
    "lifecycle",
    "unknown",
    "acp_event",
    "initialize",
    "session/resume",
    "session/set_mode",
    "session/set_config_option",
    "fs/read_text_file",
    "available_commands_update",
    "current_mode_update",
  ]) {
    assert.equal(isConversationEvent(event(kind)), false, kind);
  }
});

test("an unrecognised ACP method cannot leak in by being new", () => {
  assert.equal(isConversationEvent(event("session/some_future_method")), false);
});

test("filtering preserves order and drops only transport", () => {
  const filtered = conversationEvents([
    event("initialize", { id: "a" }),
    event("message", { id: "b" }),
    event("session/set_mode", { id: "c" }),
    event("tool_call", { id: "d" }),
    event("lifecycle", { id: "e" }),
  ]);
  assert.deepEqual(
    filtered.map((entry) => entry.id),
    ["b", "d"],
  );
});
