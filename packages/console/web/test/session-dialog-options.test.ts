import assert from "node:assert/strict";
import test from "node:test";
import { reconcileDialogOptions } from "../src/session-dialog-options";

const agents = [
  { id: "codex", label: "Codex" },
  { id: "mock", label: "Mock" },
];
const roots = [
  { id: "one", label: "One", path: "/work/one" },
  { id: "two", label: "Two", path: "/work/two" },
];

test("a live bootstrap refresh preserves still-available dialog selections", () => {
  assert.deepEqual(
    reconcileDialogOptions(
      "mock",
      "/work/two",
      agents.map((agent) => ({ ...agent })),
      roots.map((root) => ({ ...root })),
    ),
    {
      agentId: "mock",
      cwd: "/work/two",
      agentChanged: false,
      workspaceChanged: false,
    },
  );
});

test("removed selections fall back explicitly and empty inventories stay empty", () => {
  assert.deepEqual(reconcileDialogOptions("gone", "/gone", agents, roots), {
    agentId: "codex",
    cwd: "/work/one",
    agentChanged: true,
    workspaceChanged: true,
  });
  assert.deepEqual(reconcileDialogOptions("mock", "/work/two", [], []), {
    agentId: "",
    cwd: "",
    agentChanged: true,
    workspaceChanged: true,
  });
});
