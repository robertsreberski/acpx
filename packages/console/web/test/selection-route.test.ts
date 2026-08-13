import assert from "node:assert/strict";
import test from "node:test";
import { sessionIdFromPath } from "../src/selection-route";

test("session routes decode exact record ids and ignore unrelated paths", () => {
  assert.equal(sessionIdFromPath("/sessions/record%20one"), "record one");
  assert.equal(sessionIdFromPath("/sessions/record-2/"), "record-2");
  assert.equal(sessionIdFromPath("/"), null);
  assert.equal(sessionIdFromPath("/sessions/a/extra"), null);
});

test("malformed encoded session routes fail closed instead of crashing render", () => {
  assert.equal(sessionIdFromPath("/sessions/%E0%A4%A"), null);
});
