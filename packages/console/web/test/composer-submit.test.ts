import assert from "node:assert/strict";
import test from "node:test";
import { shouldSubmitComposerKey } from "../src/composer-submit";

test("plain Enter submits while Shift+Enter and IME composition keep editing", () => {
  assert.equal(shouldSubmitComposerKey("Enter", false, false), true);
  assert.equal(shouldSubmitComposerKey("Enter", true, false), false);
  assert.equal(shouldSubmitComposerKey("Enter", false, true), false);
  assert.equal(shouldSubmitComposerKey("Escape", false, false), false);
});
