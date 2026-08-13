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

const envelope = (kind: string, sequence: number, requestId?: string): TranscriptEvent => ({
  id: `event-${sequence}`,
  sequence,
  occurredAt: "2026-08-13T12:00:00.000Z",
  kind,
  ...(requestId === undefined ? {} : { requestId }),
});

test("a resume the agent refused is hidden once the fallback opened a session", () => {
  // The reconnect path: resume is refused because the agent expired its side,
  // and session/new immediately succeeds.
  const filtered = conversationEvents([
    envelope("session/resume", 4, "1"),
    envelope("jsonrpc_error", 5, "1"),
    envelope("session/new", 6, "2"),
    envelope("message", 7),
  ]);
  assert.deepEqual(
    filtered.map((event) => event.kind),
    ["message"],
  );
});

test("an establishment error stays visible when nothing afterwards succeeded", () => {
  const filtered = conversationEvents([
    envelope("session/resume", 4, "1"),
    envelope("jsonrpc_error", 5, "1"),
    envelope("session/new", 6, "2"),
    envelope("jsonrpc_error", 7, "2"),
  ]);
  assert.deepEqual(
    filtered.map((event) => event.sequence),
    [5, 7],
  );
});

test("an error from the conversation itself is never treated as a recovered reconnect", () => {
  // A prompt that failed after the session opened must still be reported.
  const filtered = conversationEvents([
    envelope("session/new", 1, "1"),
    envelope("message", 2),
    envelope("jsonrpc_error", 9, "7"),
  ]);
  assert.deepEqual(
    filtered.map((event) => event.sequence),
    [2, 9],
  );
});

test("a later failed reconnect is not excused by an earlier success", () => {
  const filtered = conversationEvents([
    envelope("session/new", 1, "1"),
    envelope("session/resume", 8, "5"),
    envelope("jsonrpc_error", 9, "5"),
  ]);
  assert.deepEqual(
    filtered.map((event) => event.sequence),
    [9],
  );
});
