import assert from "node:assert/strict";
import test from "node:test";
import { keyboardInsetFor } from "../src/keyboard-inset";

test("an open keyboard is the height the visual viewport gave up", () => {
  // iPhone 15 in portrait with the keyboard raised.
  assert.equal(
    keyboardInsetFor({ layoutHeight: 780, viewportHeight: 444, viewportOffsetTop: 0 }),
    336,
  );
});

test("a viewport scrolled to keep the field visible still reports the covered height", () => {
  // iOS pans the visual viewport up so the focused composer clears the keyboard;
  // the covered strip is what is left below that offset, not the raw difference.
  assert.equal(
    keyboardInsetFor({ layoutHeight: 780, viewportHeight: 444, viewportOffsetTop: 120 }),
    216,
  );
});

test("no keyboard means no inset", () => {
  assert.equal(
    keyboardInsetFor({ layoutHeight: 780, viewportHeight: 780, viewportOffsetTop: 0 }),
    0,
  );
});

test("sub-pixel viewport noise is not mistaken for a keyboard", () => {
  // iOS reports fractional heights while scrolling; shrinking the shell by a few
  // pixels for that would reflow the transcript on every scroll frame.
  assert.equal(
    keyboardInsetFor({ layoutHeight: 780, viewportHeight: 779.5, viewportOffsetTop: 0 }),
    0,
  );
});

test("a viewport larger than the layout never yields a negative inset", () => {
  assert.equal(
    keyboardInsetFor({ layoutHeight: 780, viewportHeight: 900, viewportOffsetTop: 0 }),
    0,
  );
});
