import assert from "node:assert/strict";
import test from "node:test";
import { anchoredScrollTop, distanceFromBottom } from "../src/scroll-anchor";

test("prepending earlier history keeps the reader on the same turn", () => {
  const before = { scrollHeight: 4_000, scrollTop: 120 };
  const anchor = distanceFromBottom(before);
  // The prepended page grew the container by 2,600px above the current view.
  assert.equal(anchoredScrollTop(6_600, anchor), 2_720);
});

test("an anchor that outgrows the container clamps instead of scrolling negative", () => {
  assert.equal(anchoredScrollTop(500, 900), 0);
});

test("a reader already at the bottom stays at the bottom", () => {
  // Scrolled fully down in an 800px viewport: scrollTop is scrollHeight - clientHeight.
  const before = { scrollHeight: 4_000, scrollTop: 3_200 };
  assert.equal(anchoredScrollTop(6_600, distanceFromBottom(before)), 5_800);
});
