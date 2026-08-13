import assert from "node:assert/strict";
import test from "node:test";
import { absoluteSessionTime, relativeSessionTime } from "../src/session-time";

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
