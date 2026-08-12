import assert from "node:assert/strict";
import test from "node:test";
import { dismissOnEscape, restoreLayerFocus } from "../src/dismissible-layer";

test("Escape dismisses a layer and consumes the key event", () => {
  const calls: string[] = [];
  const dismissed = dismissOnEscape(
    {
      key: "Escape",
      preventDefault: () => calls.push("prevented"),
      stopPropagation: () => calls.push("stopped"),
    },
    () => calls.push("dismissed"),
  );
  assert.equal(dismissed, true);
  assert.deepEqual(calls, ["prevented", "stopped", "dismissed"]);
});

test("focus restoration skips a removed opener", () => {
  let focusCount = 0;
  assert.equal(restoreLayerFocus({ focus: () => focusCount++ }), true);
  assert.equal(restoreLayerFocus({ isConnected: false, focus: () => focusCount++ }), false);
  assert.equal(focusCount, 1);
});
