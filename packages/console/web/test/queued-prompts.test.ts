import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeSessionQueuedProjection,
  reconcileQueuedPrompts,
  reconcileSessionQueuedPrompts,
  removeQueuedPrompt,
  replaceSessionQueuedPrompts,
} from "../src/queued-prompts";
import type { TranscriptEvent } from "../src/types";

const prompt = { id: "turn-2", sessionId: "session-1", text: "Run tests next" };
const event = (overrides: Partial<TranscriptEvent>): TranscriptEvent => ({
  id: "event-1",
  sequence: 1,
  occurredAt: "2026-08-12T10:00:00.000Z",
  kind: "lifecycle",
  role: "assistant",
  turnId: "turn-2",
  status: "submitted",
  ...overrides,
});

test("reconciling one session retains receipts owned by another session", () => {
  const other = { id: "turn-3", sessionId: "session-2", text: "Keep this queued" };
  assert.deepEqual(
    reconcileSessionQueuedPrompts([prompt, other], "session-1", [
      event({ kind: "message", role: "user" }),
    ]),
    [other],
  );
  assert.deepEqual(reconcileSessionQueuedPrompts([prompt, other], "session-2", []), [
    prompt,
    other,
  ]);
});

test("keeps an accepted queue receipt until durable execution or termination", () => {
  assert.deepEqual(reconcileQueuedPrompts([prompt], [event({})]), [prompt]);
  assert.deepEqual(
    reconcileQueuedPrompts([prompt], [event({ kind: "message", role: "user" })]),
    [],
  );
  assert.deepEqual(reconcileQueuedPrompts([prompt], [event({ status: "cancelled" })]), []);
  assert.deepEqual(reconcileQueuedPrompts([prompt], [event({ status: "failed" })]), []);
});

test("removes only the exact queued receipt requested by the operator", () => {
  const sameSession = { id: "turn-3", sessionId: "session-1", text: "Keep this one" };
  const sameTurnOtherSession = {
    id: prompt.id,
    sessionId: "session-2",
    text: "Same id, different session",
  };
  assert.deepEqual(
    removeQueuedPrompt([prompt, sameSession, sameTurnOtherSession], "session-1", prompt.id),
    [sameSession, sameTurnOtherSession],
  );
});

test("rebuilds exact queued controls from the durable session projection after reload", () => {
  const other = { id: "turn-other", sessionId: "session-2", text: "Other session" };
  assert.deepEqual(
    replaceSessionQueuedPrompts([prompt, other], "session-1", [
      { id: "turn-durable", text: "Recovered after reload" },
    ]),
    [other, { id: "turn-durable", sessionId: "session-1", text: "Recovered after reload" }],
  );
});

test("keeps an optimistic receipt while the owner lease projection catches up", () => {
  assert.deepEqual(mergeSessionQueuedProjection([prompt], "session-1", 0, []), [prompt]);
  assert.deepEqual(mergeSessionQueuedProjection([prompt], "session-1", 1, []), []);
});
