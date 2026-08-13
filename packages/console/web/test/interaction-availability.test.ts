import assert from "node:assert/strict";
import test from "node:test";
import { interactionAvailability } from "../src/interaction-availability";
import type { PendingInteraction } from "../src/types";

const pending: PendingInteraction = {
  id: "request-1",
  sessionId: "record-1",
  kind: "permission",
  state: "pending",
  createdAt: "2026-08-12T10:00:00.000Z",
  title: "Run tests",
};

test("a durable pending request is answerable only through an online owner", () => {
  assert.deepEqual(interactionAvailability(pending, "online"), { answerable: true });
  for (const owner of ["absent", "starting", "unreachable", "dead"] as const) {
    const state = interactionAvailability(pending, owner);
    assert.equal(state.answerable, false);
    assert.match(state.reason ?? "", new RegExp(owner));
  }
});

test("settled durable requests stay read-only even with a live owner", () => {
  assert.deepEqual(interactionAvailability({ ...pending, state: "answered" }, "online"), {
    answerable: false,
    reason: "This request is answered.",
  });
});

test("a pending request with an unconfirmed prior answer stays read-only", () => {
  const state = interactionAvailability({ ...pending, responseOutcome: "unknown" }, "online");
  assert.equal(state.answerable, false);
  assert.match(state.reason ?? "", /previous answer may still be applied/u);
});
