import assert from "node:assert/strict";
import test from "node:test";
import { dismissOnEscape, restoreLayerFocus, trapLayerTab } from "../src/dismissible-layer";

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

test("Tab wraps within the active layer", () => {
  const calls: string[] = [];
  const first = { focus: () => calls.push("first") };
  const last = { focus: () => calls.push("last") };
  const layer = {
    contains: (target: unknown) => target === first || target === last,
    querySelectorAll: () => [first, last],
  };
  const event = {
    key: "Tab",
    preventDefault: () => calls.push("prevented"),
    stopPropagation: () => undefined,
  };
  assert.equal(trapLayerTab(event, layer, last), true);
  assert.deepEqual(calls, ["prevented", "first"]);
  calls.length = 0;
  assert.equal(trapLayerTab({ ...event, shiftKey: true }, layer, first), true);
  assert.deepEqual(calls, ["prevented", "last"]);
});

test("focus restoration skips a removed opener", () => {
  let focusCount = 0;
  assert.equal(restoreLayerFocus({ focus: () => focusCount++ }), true);
  assert.equal(restoreLayerFocus({ isConnected: false, focus: () => focusCount++ }), false);
  assert.equal(focusCount, 1);
});
