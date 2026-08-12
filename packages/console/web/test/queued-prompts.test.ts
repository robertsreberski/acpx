import assert from "node:assert/strict";
import test from "node:test";
import { reconcileQueuedPrompts } from "../src/queued-prompts";
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

test("keeps an accepted queue receipt until durable execution or termination", () => {
  assert.deepEqual(reconcileQueuedPrompts([prompt], [event({})]), [prompt]);
  assert.deepEqual(
    reconcileQueuedPrompts([prompt], [event({ kind: "message", role: "user" })]),
    [],
  );
  assert.deepEqual(reconcileQueuedPrompts([prompt], [event({ status: "failed" })]), []);
});
