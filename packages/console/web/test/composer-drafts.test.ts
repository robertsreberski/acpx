import assert from "node:assert/strict";
import test from "node:test";
import {
  clearComposerDraftIfSent,
  composerDraftForSession,
  setComposerDraftForSession,
} from "../src/composer-drafts";

test("keeps a separate unsent composer draft for every session", () => {
  const first = setComposerDraftForSession({}, "session-a", "review the tests");
  const both = setComposerDraftForSession(first, "session-b", "ship the fix");
  assert.equal(composerDraftForSession(both, "session-a"), "review the tests");
  assert.equal(composerDraftForSession(both, "session-b"), "ship the fix");
  assert.equal(composerDraftForSession(both, null), "");
});

test("clears only the exact draft that was successfully submitted", () => {
  const drafts = { "session-a": "draft changed", "session-b": "keep me" };
  assert.equal(clearComposerDraftIfSent(drafts, "session-a", "older value"), drafts);
  assert.equal(clearComposerDraftIfSent(drafts, "session-a", " draft changed "), drafts);
  assert.deepEqual(clearComposerDraftIfSent(drafts, "session-a", "draft changed"), {
    "session-b": "keep me",
  });
});
