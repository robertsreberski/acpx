import assert from "node:assert/strict";
import test from "node:test";
import { sessionGroup } from "../src/session-store";
import type { SessionSummary } from "../src/types";

const summary = (pendingCount: number): SessionSummary => ({
  id: "record-live-only-pending",
  name: "Live-only pending",
  agentId: "codex",
  agentLabel: "Codex",
  cwd: "/tmp/workspace",
  sessionState: "open",
  ownerState: "online",
  turnState: "idle",
  pendingCount,
  queuedCount: 0,
  queuedTurns: [],
  createdAt: "2026-08-13T12:00:00.000Z",
  updatedAt: "2026-08-13T12:00:00.000Z",
  lastActivityAt: "2026-08-13T12:00:00.000Z",
});

test("an authoritative pending count groups a session under Needs you", () => {
  assert.equal(sessionGroup(summary(1)), "needs");
  assert.equal(sessionGroup(summary(0)), "open");
});
