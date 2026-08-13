import assert from "node:assert/strict";
import test from "node:test";
import { absoluteSessionTime, compactSessionTime, relativeSessionTime } from "../src/session-time";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

test("relative session timestamps change when the minute clock advances", () => {
  const activity = "2026-08-13T11:58:30.000Z";
  assert.equal(relativeSessionTime(activity, NOW, "en"), "2 minutes ago");
  assert.equal(relativeSessionTime(activity, NOW + 60_000, "en"), "3 minutes ago");
});

test("session timestamps retain an absolute label and tolerate malformed input", () => {
  assert.notEqual(absoluteSessionTime("2026-08-13T11:58:30.000Z", "en"), "Unknown time");
  assert.equal(absoluteSessionTime("not-a-date", "en"), "Unknown time");
  assert.equal(relativeSessionTime("not-a-date", NOW, "en"), "Unknown time");
});

test("the session list ages rows compactly enough to sit beside a title", () => {
  assert.equal(compactSessionTime("2026-08-13T11:59:40.000Z", NOW), "now");
  assert.equal(compactSessionTime("2026-08-13T11:58:00.000Z", NOW), "2m");
  assert.equal(compactSessionTime("2026-08-13T09:00:00.000Z", NOW), "3h");
  assert.equal(compactSessionTime("2026-08-11T12:00:00.000Z", NOW), "2d");
  assert.equal(compactSessionTime("2026-07-23T12:00:00.000Z", NOW), "3w");
});

test("a compact age never renders a future turn as a negative age", () => {
  assert.equal(compactSessionTime("2026-08-13T12:05:00.000Z", NOW), "now");
  assert.equal(compactSessionTime("not-a-date", NOW), "—");
});
