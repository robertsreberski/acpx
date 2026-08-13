import assert from "node:assert/strict";
import test from "node:test";
import { closeSessionFeedback } from "../src/close-session-feedback";
import type { SessionDetail } from "../src/types";

const session = {} as SessionDetail;

test("reports provider-confirmed closure as success", () => {
  assert.deepEqual(
    closeSessionFeedback({ session, localClose: "closed", providerClose: { status: "confirmed" } }),
    { message: "Session closed.", tone: "success" },
  );
});

test("does not present a degraded provider close as fully confirmed", () => {
  const feedback = closeSessionFeedback({
    session,
    localClose: "closed",
    providerClose: { status: "degraded", reason: "provider_error" },
  });
  assert.equal(feedback.tone, "info");
  assert.match(feedback.message, /closed locally/u);
  assert.match(feedback.message, /did not confirm shutdown/u);
});
