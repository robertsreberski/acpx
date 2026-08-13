import assert from "node:assert/strict";
import test from "node:test";
import { dockedInteraction } from "../src/docked-interaction";
import type { PendingInteraction } from "../src/types";

const request = (overrides: Partial<PendingInteraction> = {}): PendingInteraction => ({
  id: "req-1",
  sessionId: "record-1",
  kind: "permission",
  state: "pending",
  createdAt: "2026-08-13T12:00:00.000Z",
  title: "Write coupon.ts?",
  ...overrides,
});

test("the request that stalled the turn is the one that docks", () => {
  const docked = dockedInteraction([request({ id: "req-1" }), request({ id: "req-2" })]);
  assert.equal(docked?.id, "req-1");
});

test("settled requests never dock", () => {
  assert.equal(dockedInteraction([request({ state: "answered" })]), undefined);
  assert.equal(dockedInteraction([]), undefined);
  assert.equal(
    dockedInteraction([request({ id: "old", state: "cancelled" }), request({ id: "live" })])?.id,
    "live",
  );
});

test("an unanswerable request does not park in front of one the service still takes", () => {
  const docked = dockedInteraction(
    [request({ id: "unconfirmed", responseOutcome: "unknown" }), request({ id: "answerable" })],
    "online",
  );
  assert.equal(docked?.id, "answerable");
});

test("when nothing can be answered the oldest still docks, so the reason is visible", () => {
  const docked = dockedInteraction([request({ id: "first" }), request({ id: "second" })], "dead");
  assert.equal(docked?.id, "first");
});
