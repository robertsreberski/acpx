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

test("a removed agent falls back explicitly and an empty inventory stays empty", () => {
  assert.deepEqual(reconcileDialogOptions("gone", "/work/one", agents, roots), {
    agentId: "codex",
    cwd: "/work/one",
    agentChanged: true,
    workspaceChanged: false,
  });
  assert.deepEqual(reconcileDialogOptions("mock", "/work/two", [], roots), {
    agentId: "",
    cwd: "/work/two",
    agentChanged: true,
    workspaceChanged: false,
  });
});

test("a workspace outside the configured roots is kept, not snapped back to one", () => {
  // Any directory can be used once authorized, so the roots are only a default.
  assert.deepEqual(reconcileDialogOptions("mock", "/elsewhere/project", agents, roots), {
    agentId: "mock",
    cwd: "/elsewhere/project",
    agentChanged: false,
    workspaceChanged: false,
  });
});

test("an empty workspace opens on the first configured root", () => {
  assert.equal(reconcileDialogOptions("mock", "", agents, roots).cwd, "/work/one");
  assert.equal(reconcileDialogOptions("mock", "", agents, []).cwd, "");
});
