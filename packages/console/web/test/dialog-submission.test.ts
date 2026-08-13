import assert from "node:assert/strict";
import test from "node:test";
import { DialogSubmission } from "../src/dialog-submission";

test("a pending dialog submission cannot be dismissed", () => {
  const submission = new DialogSubmission();

  submission.begin();

  assert.equal(submission.pending, true);
  assert.equal(submission.dismiss(), false);
});

test("a replaced dialog ignores the previous opening's completion", () => {
  const submission = new DialogSubmission();
  const previous = submission.begin();

  submission.replace();
  const current = submission.begin();

  assert.equal(submission.complete(previous), false);
  assert.equal(submission.pending, true);
  assert.equal(submission.complete(current), true);
  assert.equal(submission.pending, false);
});
