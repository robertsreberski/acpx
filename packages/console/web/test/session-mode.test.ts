import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExactId, requiresExplicitMode, safeDefaultMode } from "../src/session-mode";

test("built-in agents expose their safe defaults without requiring a mode", () => {
  const codex = { id: "codex", label: "Codex" };
  const claude = { id: "claude", label: "Claude" };
  assert.equal(safeDefaultMode(codex), "read-only");
  assert.equal(safeDefaultMode(claude), "default");
  assert.equal(requiresExplicitMode(codex), false);
  assert.equal(requiresExplicitMode(claude), false);
});

test("custom agents require an exact free-form mode", () => {
  const agent = { id: "mock", label: "Mock" };
  assert.equal(safeDefaultMode(agent), undefined);
  assert.equal(requiresExplicitMode(agent), true);
});

test("exact mode and model IDs are trimmed and blank values are omitted", () => {
  assert.equal(normalizeExactId("  review  "), "review");
  assert.equal(normalizeExactId("  gpt-custom  "), "gpt-custom");
  assert.equal(normalizeExactId("  "), undefined);
});
