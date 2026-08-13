import assert from "node:assert/strict";
import test from "node:test";
import {
  expireOptimisticQueuedPrompts,
  mergeSessionQueuedProjection,
  OPTIMISTIC_QUEUE_GRACE_MS,
  reconcileQueuedPrompts,
  reconcileSessionQueuedPrompts,
  removeQueuedPrompt,
  replaceSessionQueuedPrompts,
  unavailableQueuedControlsMessage,
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
  const accepted = { ...prompt, optimisticSince: 1_000 };
  assert.deepEqual(mergeSessionQueuedProjection([accepted], "session-1", "online", [], 1_001), [
    accepted,
  ]);
});

test("clears a fake queued control when its owner is lost or projection grace expires", () => {
  const other = { id: "turn-other", sessionId: "session-2", text: "Other session" };
  const accepted = { ...prompt, optimisticSince: 1_000 };
  for (const ownerState of ["absent", "starting", "unreachable", "dead"] as const) {
    assert.deepEqual(
      mergeSessionQueuedProjection([accepted, other], "session-1", ownerState, [], 1_001),
      [other],
    );
  }
  assert.deepEqual(
    mergeSessionQueuedProjection(
      [accepted, other],
      "session-1",
      "online",
      [],
      1_000 + OPTIMISTIC_QUEUE_GRACE_MS + 1,
    ),
    [other],
  );
});

test("never revives a durable queue row as an optimistic receipt", () => {
  const durable = { id: "turn-durable", sessionId: "session-1", text: "Durable" };
  assert.deepEqual(mergeSessionQueuedProjection([durable], "session-1", "online", [], 1_000), []);
});

test("a timer cleanup expires optimistic rows without deleting durable rows", () => {
  const accepted = { ...prompt, optimisticSince: 1_000 };
  const durable = { id: "turn-durable", sessionId: "session-1", text: "Durable" };
  assert.deepEqual(
    expireOptimisticQueuedPrompts([accepted, durable], 1_000 + OPTIMISTIC_QUEUE_GRACE_MS + 1),
    [durable],
  );
});

test("explains when lease depth has no safe cancellation targets", () => {
  assert.equal(unavailableQueuedControlsMessage(0, 0), undefined);
  assert.equal(
    unavailableQueuedControlsMessage(2, 1),
    "1 queued follow-up has no exact control while the queue owner is reconciling or unavailable.",
  );
  assert.equal(
    unavailableQueuedControlsMessage(2, 0),
    "2 queued follow-ups have no exact control while the queue owner is reconciling or unavailable.",
  );
});
