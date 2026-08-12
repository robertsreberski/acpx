import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { findPersistedKeyPolicyViolations } from "../src/persisted-key-policy.js";
import {
  PENDING_REQUEST_SCHEMA,
  deletePendingRequestsForSession,
  listPendingRequests,
  parsePendingRequest,
  pendingRequestFilePath,
  pendingRequestsSessionDir,
  readPendingRequest,
  serializePendingRequestForDisk,
  sweepPendingRequests,
  writePendingRequest,
  type PendingRequest,
} from "../src/session/pending-requests.js";
import { withTempHome } from "./queue-test-helpers.js";

function makeEntry(overrides: Partial<PendingRequest> = {}): PendingRequest {
  return {
    schema: PENDING_REQUEST_SCHEMA,
    requestId: "req-1",
    sessionId: "session-record-1",
    acpSessionId: "acp-session-1",
    agentCommand: "node ./test/mock-agent.js",
    cwd: "/workspace",
    kind: "permission",
    state: "pending",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    ownerPid: 4242,
    ownerGeneration: 99,
    taskRequestId: "task-1",
    toolCall: {
      toolCallId: "tool-1",
      title: "Bash: pnpm test",
      kind: "execute",
      rawInput: { command: "pnpm", args: ["test"] },
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
    ...overrides,
  };
}

test("pending request round-trips through disk unchanged", async () => {
  await withTempHome(async () => {
    const entry = makeEntry();
    await writePendingRequest(entry);

    const loaded = await readPendingRequest(entry.sessionId, entry.requestId);
    assert.deepEqual(loaded, entry);
  });
});

test("pending request persists the full option list verbatim", async () => {
  await withTempHome(async () => {
    // Plan-mode option sets carry adapter-specific ids and names that a
    // responder must be able to echo back exactly.
    const options: PendingRequest["options"] = [
      { optionId: "plan-accept-edits", name: "Accept edits", kind: "allow_always" },
      { optionId: "plan-once", name: "Allow once", kind: "allow_once" },
      { optionId: "plan-reject", name: "Keep planning", kind: "reject_once" },
      { optionId: "plan-abort", name: "Abort", kind: "reject_always" },
    ];
    const entry = makeEntry({ requestId: "req-plan", options });
    await writePendingRequest(entry);

    const loaded = await readPendingRequest(entry.sessionId, entry.requestId);
    assert.deepEqual(loaded?.options, options);
  });
});

test("serialized pending request uses snake_case persisted keys", () => {
  const persisted = serializePendingRequestForDisk(
    makeEntry({
      expiresAt: "2026-08-13T00:00:00.000Z",
      state: "answered",
      resolution: {
        answeredAt: "2026-08-12T01:00:00.000Z",
        source: "cli",
        optionId: "allow",
        action: "defer",
      },
    }),
  );

  assert.deepEqual(findPersistedKeyPolicyViolations(persisted), []);
  for (const key of [
    "schema",
    "request_id",
    "session_id",
    "acp_session_id",
    "agent_command",
    "cwd",
    "kind",
    "state",
    "created_at",
    "updated_at",
    "expires_at",
    "owner_pid",
    "owner_generation",
    "task_request_id",
    "tool_call",
    "options",
    "resolution",
  ]) {
    assert.equal(key in persisted, true, `serialized pending request is missing ${key}`);
  }
  for (const key of ["requestId", "sessionId", "toolCall", "ownerPid", "taskRequestId"]) {
    assert.equal(key in persisted, false, `serialized pending request leaked camelCase ${key}`);
  }
});

test("agent-supplied raw input keys survive without tripping the key policy", () => {
  const persisted = serializePendingRequestForDisk(
    makeEntry({
      toolCall: {
        toolCallId: "tool-raw",
        title: "Bash",
        rawInput: { camelCaseFromAgent: 1, "weird-key": true },
      },
    }),
  );

  assert.deepEqual(findPersistedKeyPolicyViolations(persisted), []);
  assert.deepEqual((persisted.tool_call as { raw_input?: unknown }).raw_input, {
    camelCaseFromAgent: 1,
    "weird-key": true,
  });
});

test("pending request writes are atomic and leave no temp files behind", async () => {
  await withTempHome(async () => {
    const entry = makeEntry();
    await writePendingRequest(entry);
    await writePendingRequest({
      ...entry,
      state: "answered",
      updatedAt: "2026-08-12T02:00:00.000Z",
    });

    const dir = pendingRequestsSessionDir(entry.sessionId);
    const files = await fs.readdir(dir);
    assert.deepEqual(files, [path.basename(pendingRequestFilePath(entry.sessionId, "req-1"))]);

    const loaded = await readPendingRequest(entry.sessionId, entry.requestId);
    assert.equal(loaded?.state, "answered");
  });
});

test("listPendingRequests returns every entry and ignores unreadable files", async () => {
  await withTempHome(async () => {
    await writePendingRequest(makeEntry({ requestId: "req-a" }));
    await writePendingRequest(makeEntry({ requestId: "req-b", state: "expired" }));

    const dir = pendingRequestsSessionDir("session-record-1");
    await fs.writeFile(path.join(dir, "garbage.json"), "{not json\n", "utf8");
    await fs.writeFile(path.join(dir, "not-a-request.txt"), "ignored\n", "utf8");

    const entries = await listPendingRequests("session-record-1");
    assert.deepEqual(entries.map((entry) => entry.requestId).toSorted(), ["req-a", "req-b"]);
  });
});

test("listPendingRequests is empty for a session that has none", async () => {
  await withTempHome(async () => {
    assert.deepEqual(await listPendingRequests("never-used"), []);
  });
});

test("deletePendingRequestsForSession removes the whole session directory", async () => {
  await withTempHome(async () => {
    await writePendingRequest(makeEntry());
    await deletePendingRequestsForSession("session-record-1");

    assert.deepEqual(await listPendingRequests("session-record-1"), []);
    await assert.rejects(async () => await fs.stat(pendingRequestsSessionDir("session-record-1")));
    // Deleting again is not an error.
    await deletePendingRequestsForSession("session-record-1");
  });
});

test("parsePendingRequest rejects payloads that are not this schema", () => {
  const persisted = serializePendingRequestForDisk(makeEntry());

  assert.notEqual(parsePendingRequest(persisted), undefined);
  assert.equal(parsePendingRequest({ ...persisted, schema: "acpx.pending_request.v0" }), undefined);
  assert.equal(parsePendingRequest({ ...persisted, state: "unknown" }), undefined);
  assert.equal(parsePendingRequest({ ...persisted, kind: "elicitation" }), undefined);
  assert.equal(parsePendingRequest({ ...persisted, options: [{ option_id: "allow" }] }), undefined);
  assert.equal(parsePendingRequest(null), undefined);
  assert.equal(parsePendingRequest([]), undefined);
});

test("session ids that are not path-safe still get their own directory", async () => {
  await withTempHome(async () => {
    const entry = makeEntry({ sessionId: "weird/../id", requestId: "req-safe" });
    await writePendingRequest(entry);

    const loaded = await readPendingRequest(entry.sessionId, entry.requestId);
    assert.deepEqual(loaded, entry);
    assert.equal(pendingRequestsSessionDir(entry.sessionId).includes(".."), false);
  });
});

test("sweep orphans pending entries left by a previous owner generation", async () => {
  await withTempHome(async () => {
    await writePendingRequest(makeEntry({ requestId: "stale", ownerGeneration: 1 }));
    await writePendingRequest(makeEntry({ requestId: "mine", ownerGeneration: 2 }));

    const result = await sweepPendingRequests({
      sessionId: "session-record-1",
      ownerGeneration: 2,
    });

    assert.deepEqual(
      result.orphaned.map((entry) => entry.requestId),
      ["stale"],
    );
    assert.equal((await readPendingRequest("session-record-1", "stale"))?.state, "orphaned");
    // The live owner's own pending entry is untouched.
    assert.equal((await readPendingRequest("session-record-1", "mine"))?.state, "pending");
  });
});

test("sweep prunes terminal entries past the retention window and keeps fresh ones", async () => {
  await withTempHome(async () => {
    const now = new Date("2026-08-12T00:00:00.000Z");
    await writePendingRequest(
      makeEntry({ requestId: "old", state: "answered", updatedAt: "2026-08-01T00:00:00.000Z" }),
    );
    await writePendingRequest(
      makeEntry({ requestId: "recent", state: "expired", updatedAt: "2026-08-11T00:00:00.000Z" }),
    );

    const result = await sweepPendingRequests({
      sessionId: "session-record-1",
      ownerGeneration: 99,
      now,
    });

    assert.deepEqual(result.pruned, ["old"]);
    assert.equal(await readPendingRequest("session-record-1", "old"), undefined);
    assert.equal((await readPendingRequest("session-record-1", "recent"))?.state, "expired");
  });
});
