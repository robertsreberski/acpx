import assert from "node:assert/strict";
import test from "node:test";
import { reconcileQueuedPrompts, reconcileSessionQueuedPrompts } from "../src/queued-prompts";
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
  assert.deepEqual(reconcileQueuedPrompts([prompt], [event({ status: "failed" })]), []);
});
