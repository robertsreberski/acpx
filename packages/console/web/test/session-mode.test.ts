import assert from "node:assert/strict";
import test from "node:test";
import { modeControlType, normalizeSessionMode, requiresExplicitMode } from "../src/session-mode";

test("built-in agents retain safe defaults when no mode catalog is advertised", () => {
  for (const id of ["codex", "claude"]) {
    const agent = { id, label: id };
    assert.equal(requiresExplicitMode(agent), false);
    assert.equal(modeControlType(agent), "none");
    assert.equal(normalizeSessionMode("  "), undefined);
  }
});

test("custom agents require a free-form mode when no catalog is advertised", () => {
  const agent = { id: "mock", label: "Mock" };
  assert.equal(requiresExplicitMode(agent), true);
  assert.equal(modeControlType(agent), "input");
  assert.equal(normalizeSessionMode("  review  "), "review");
  assert.equal(normalizeSessionMode("  "), undefined);
});

test("advertised mode catalogs keep a select control without weakening custom validation", () => {
  const agent = {
    id: "mock",
    label: "Mock",
    modes: [{ id: "review", label: "Review" }],
  };
  assert.equal(requiresExplicitMode(agent), true);
  assert.equal(modeControlType(agent), "select");
});
