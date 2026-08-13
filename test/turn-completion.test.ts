import assert from "node:assert/strict";
import test from "node:test";
import { TurnCompletionTracker } from "../src/runtime/engine/turn-completion.js";
import type { SessionNotification } from "../src/types.js";

function notification(update: SessionNotification["update"]): SessionNotification {
  return { sessionId: "session-1", update };
}

function compaction(toolCallId = "compact-1"): SessionNotification {
  return notification({
    sessionUpdate: "tool_call",
    toolCallId,
    title: "Context compaction",
    _meta: { contextCompaction: true },
  });
}

function compactionUpdate(toolCallId = "compact-1"): SessionNotification {
  return notification({
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "completed",
    _meta: { contextCompaction: true },
  });
}

function message(text: string, phase?: string): SessionNotification {
  return notification({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    ...(phase ? { _meta: { codex: { phase } } } : {}),
  });
}

test("turn completion ignores compaction evidence outside a live attempt", () => {
  const tracker = new TurnCompletionTracker();
  tracker.observe(compaction());
  tracker.beginAttempt();
  assert.deepEqual(tracker.finish("end_turn"), {
    status: "completed",
    stopReason: "end_turn",
  });
});

test("turn completion marks end_turn incomplete after unanswered context compaction", () => {
  const tracker = new TurnCompletionTracker();
  tracker.beginAttempt();
  tracker.observe(compaction());
  assert.deepEqual(tracker.finish("end_turn"), {
    status: "incomplete",
    stopReason: "end_turn",
    reason: "context_compaction",
  });
});

test("turn completion accepts a nonempty Codex final answer after compaction", () => {
  const tracker = new TurnCompletionTracker();
  tracker.beginAttempt();
  tracker.observe(compaction());
  tracker.observe(message("Verdict", "final_answer"));
  assert.deepEqual(tracker.finish("end_turn"), {
    status: "completed",
    stopReason: "end_turn",
  });
});

test("turn completion rejects commentary, empty text, and a final answer before compaction", () => {
  const tracker = new TurnCompletionTracker();
  tracker.beginAttempt();
  tracker.observe(message("Earlier verdict", "final_answer"));
  tracker.observe(compaction());
  tracker.observe(message("Still working", "commentary"));
  tracker.observe(message("   ", "final_answer"));
  assert.deepEqual(tracker.finish("end_turn"), {
    status: "incomplete",
    stopReason: "end_turn",
    reason: "context_compaction",
  });
});

test("turn completion does not combine final-answer metadata and text across chunks", () => {
  const tracker = new TurnCompletionTracker();
  tracker.beginAttempt();
  tracker.observe(compaction());
  tracker.observe(message("", "final_answer"));
  tracker.observe(message("Verdict without repeated metadata"));
  assert.deepEqual(tracker.finish("end_turn"), {
    status: "incomplete",
    stopReason: "end_turn",
    reason: "context_compaction",
  });
});

test("turn completion deduplicates compaction updates by tool call id", () => {
  const tracker = new TurnCompletionTracker();
  tracker.beginAttempt();
  tracker.observe(compaction());
  tracker.observe(message("Verdict", "final_answer"));
  tracker.observe(compactionUpdate());
  assert.deepEqual(tracker.finish("end_turn"), {
    status: "completed",
    stopReason: "end_turn",
  });
});

test("turn completion requires a final answer after the latest distinct compaction", () => {
  const tracker = new TurnCompletionTracker();
  tracker.beginAttempt();
  tracker.observe(compaction("compact-1"));
  tracker.observe(message("First verdict", "final_answer"));
  tracker.observe(compaction("compact-2"));
  assert.deepEqual(tracker.finish("end_turn"), {
    status: "incomplete",
    stopReason: "end_turn",
    reason: "context_compaction",
  });
});

test("turn completion preserves cancellation and requires final evidence for other stop reasons", () => {
  const cancelled = new TurnCompletionTracker();
  cancelled.beginAttempt();
  cancelled.observe(compaction());
  assert.deepEqual(cancelled.finish("cancelled"), {
    status: "cancelled",
    stopReason: "cancelled",
  });

  const limited = new TurnCompletionTracker();
  limited.beginAttempt();
  limited.observe(compaction());
  assert.deepEqual(limited.finish("max_tokens"), {
    status: "incomplete",
    stopReason: "max_tokens",
    reason: "context_compaction",
  });
});

test("turn completion resets evidence for every prompt attempt", () => {
  const tracker = new TurnCompletionTracker();
  tracker.beginAttempt();
  tracker.observe(compaction());
  tracker.abandonAttempt();
  tracker.beginAttempt();
  assert.deepEqual(tracker.finish("end_turn"), {
    status: "completed",
    stopReason: "end_turn",
  });
});
