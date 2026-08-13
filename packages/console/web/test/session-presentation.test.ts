import assert from "node:assert/strict";
import test from "node:test";
import {
  displayRepo,
  groupSessionsByRepo,
  harnessLine,
  humanizeModeId,
  modeBadge,
  sessionMode,
  sessionStatus,
} from "../src/session-presentation";
import type { SessionSummary } from "../src/types";

const summary = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "record-1",
  name: "Fix checkout regression",
  agentId: "claude",
  agentLabel: "claude-code",
  cwd: "/Users/dev/src/storefront",
  sessionState: "open",
  ownerState: "online",
  turnState: "idle",
  pendingCount: 0,
  queuedCount: 0,
  queuedTurns: [],
  createdAt: "2026-08-13T12:00:00.000Z",
  updatedAt: "2026-08-13T12:00:00.000Z",
  lastActivityAt: "2026-08-13T12:00:00.000Z",
  ...overrides,
});

test("the project name prefers the reported repo and falls back to the workspace leaf", () => {
  assert.equal(displayRepo(summary({ repo: "storefront" })), "storefront");
  assert.equal(displayRepo(summary()), "storefront");
  assert.equal(displayRepo(summary({ cwd: "/Users/dev/src/storefront/" })), "storefront");
});

test("the badge reports the mode actually in force, not the one that was requested", () => {
  const session = summary({ desiredMode: "plan", mode: "plan", effectiveMode: "acceptEdits" });
  assert.equal(sessionMode(session), "acceptEdits");
  assert.deepEqual(modeBadge(session), { label: "Accept edits", canWrite: true });
});

test("propose-only modes read neutral and write-capable modes read as writers", () => {
  for (const mode of ["plan", "read-only", "readonly", "ask", "review"]) {
    assert.equal(modeBadge(summary({ mode }))?.canWrite, false, mode);
  }
  for (const mode of ["default", "acceptEdits", "bypassPermissions", "yolo"]) {
    assert.equal(modeBadge(summary({ mode }))?.canWrite, true, mode);
  }
});

test("a session without any reported mode shows no badge rather than guessing one", () => {
  assert.equal(modeBadge(summary()), undefined);
  assert.equal(modeBadge(summary({ mode: "   " })), undefined);
});

test("mode ids are humanized from both snake and camel spellings", () => {
  assert.equal(humanizeModeId("read-only"), "Read only");
  assert.equal(humanizeModeId("acceptEdits"), "Accept edits");
  assert.equal(humanizeModeId("waiting_permission"), "Waiting permission");
});

test("the harness line omits parts the sessions contract does not carry", () => {
  assert.equal(harnessLine(summary({ model: "sonnet-4.5" })), "claude-code · sonnet-4.5");
  assert.equal(harnessLine(summary()), "claude-code");
});

test("a waiting request outranks live work in the status line", () => {
  assert.deepEqual(sessionStatus(summary({ pendingCount: 1, turnState: "running" })), {
    text: "Needs you",
    tone: "needs",
  });
  assert.deepEqual(sessionStatus(summary({ turnState: "waiting_permission" })), {
    text: "Needs you",
    tone: "needs",
  });
});

test("queue depth travels with the status wherever it is reported", () => {
  assert.deepEqual(sessionStatus(summary({ turnState: "running", queuedCount: 2 })), {
    text: "Running · 2 queued",
    tone: "working",
  });
  assert.deepEqual(sessionStatus(summary({ pendingCount: 1, queuedCount: 1 })), {
    text: "Needs you · 1 queued",
    tone: "needs",
  });
});

test("a settled turn reports its own state rather than claiming to be working", () => {
  assert.deepEqual(sessionStatus(summary({ turnState: "completed" })), {
    text: "Completed",
    tone: "idle",
  });
});

test("sessions group under their project with the most recent row first", () => {
  const groups = groupSessionsByRepo([
    summary({ id: "a", repo: "payments", lastActivityAt: "2026-08-13T12:00:00.000Z" }),
    summary({ id: "b", repo: "storefront", lastActivityAt: "2026-08-13T11:00:00.000Z" }),
    summary({ id: "c", repo: "storefront", lastActivityAt: "2026-08-13T13:00:00.000Z" }),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.repo, group.sessions.map((session) => session.id)]),
    [
      ["payments", ["a"]],
      ["storefront", ["c", "b"]],
    ],
  );
});

test("grouping is stable across turn changes so rows never jump between projects", () => {
  const before = groupSessionsByRepo([summary({ id: "a", repo: "storefront" })]);
  const after = groupSessionsByRepo([
    summary({ id: "a", repo: "storefront", turnState: "running", pendingCount: 3 }),
  ]);
  assert.deepEqual(
    before.map((group) => group.repo),
    after.map((group) => group.repo),
  );
});
