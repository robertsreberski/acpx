import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPersistedKeyPolicyViolations } from "../src/persisted-key-policy.js";
import {
  PENDING_REQUEST_SCHEMA,
  serializePendingRequestForDisk,
  type PendingRequest,
} from "../src/session/pending-requests.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";

function makeRecord(): SessionRecord {
  return {
    schema: "acpx.session.v1",
    acpxRecordId: "lint-record",
    acpSessionId: "lint-session",
    agentSessionId: "agent-session",
    agentCommand: "npx -y @agentclientprotocol/codex-acp",
    cwd: "/tmp/lint",
    createdAt: "2026-02-27T00:00:00.000Z",
    lastUsedAt: "2026-02-27T00:00:00.000Z",
    lastSeq: 0,
    lastRequestId: undefined,
    eventLog: {
      active_path: "/tmp/lint-record.events.ndjson",
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: undefined,
      last_write_error: null,
    },
    closed: false,
    title: null,
    messages: [],
    updated_at: "2026-02-27T00:00:00.000Z",
    cumulative_token_usage: {},
    request_token_usage: {},
    acpx: {
      current_mode_id: "code",
      available_commands: ["run"],
    },
  };
}

function assertSerializationPolicy(): void {
  const persisted = serializeSessionRecordForDisk(makeRecord());
  const violations = findPersistedKeyPolicyViolations(persisted);
  assert.equal(
    violations.length,
    0,
    `serializeSessionRecordForDisk emitted non-snake keys: ${violations.join(", ")}`,
  );

  const requiredTopLevel = [
    "schema",
    "acpx_record_id",
    "acp_session_id",
    "agent_session_id",
    "agent_command",
    "cwd",
    "created_at",
    "last_used_at",
    "last_seq",
    "event_log",
    "title",
    "messages",
    "updated_at",
    "cumulative_token_usage",
    "request_token_usage",
  ];

  for (const key of requiredTopLevel) {
    assert.equal(
      key in persisted,
      true,
      `serialized session record is missing required key: ${key}`,
    );
  }

  const forbiddenTopLevel = [
    "acpxRecordId",
    "acpSessionId",
    "agentSessionId",
    "agentCommand",
    "createdAt",
    "lastUsedAt",
    "lastSeq",
    "lastRequestId",
    "eventLog",
    "closedAt",
    "agentStartedAt",
    "lastPromptAt",
    "lastAgentExitCode",
    "lastAgentExitSignal",
    "lastAgentExitAt",
    "lastAgentDisconnectReason",
    "protocolVersion",
    "agentCapabilities",
  ];

  for (const key of forbiddenTopLevel) {
    assert.equal(
      key in persisted,
      false,
      `serialized session record must not emit camelCase key: ${key}`,
    );
  }
}

function assertSerializerSourceKeys(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.join(scriptDir, "..", "src", "session", "persistence", "serialize.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  const serializerStart = source.indexOf("export function serializeSessionRecordForDisk");
  assert.notEqual(serializerStart, -1, "serializeSessionRecordForDisk not found");

  const serializerBlock = source.slice(serializerStart);
  const forbiddenPersistedKeys = [
    "acpxRecordId",
    "acpSessionId",
    "agentSessionId",
    "agentCommand",
    "createdAt",
    "lastUsedAt",
    "lastSeq",
    "lastRequestId",
    "eventLog",
    "closedAt",
    "agentStartedAt",
    "lastPromptAt",
    "lastAgentExitCode",
    "lastAgentExitSignal",
    "lastAgentExitAt",
    "lastAgentDisconnectReason",
    "protocolVersion",
    "agentCapabilities",
  ];

  for (const key of forbiddenPersistedKeys) {
    const matcher = new RegExp(`\\b${key}\\s*:`, "g");
    assert.equal(
      matcher.test(serializerBlock),
      false,
      `serializer contains non-snake persisted key literal: ${key}`,
    );
  }
}

function makePendingRequest(): PendingRequest {
  return {
    schema: PENDING_REQUEST_SCHEMA,
    requestId: "lint-request",
    sessionId: "lint-session",
    acpSessionId: "lint-acp-session",
    agentCommand: "npx -y @agentclientprotocol/codex-acp",
    cwd: "/tmp/lint",
    kind: "permission",
    state: "pending",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    expiresAt: "2026-08-13T00:00:00.000Z",
    ownerPid: 1234,
    ownerGeneration: 5678,
    taskRequestId: "lint-task",
    toolCall: {
      toolCallId: "lint-tool",
      title: "Bash",
      kind: "execute",
      rawInput: { command: "pnpm", camelCaseFromAgent: true },
    },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    resolution: {
      answeredAt: "2026-08-12T01:00:00.000Z",
      source: "cli",
      optionId: "allow",
      action: "defer",
    },
  };
}

function assertPendingRequestSerializationPolicy(): void {
  const persisted = serializePendingRequestForDisk(makePendingRequest());
  const violations = findPersistedKeyPolicyViolations(persisted);
  assert.equal(
    violations.length,
    0,
    `serializePendingRequestForDisk emitted non-snake keys: ${violations.join(", ")}`,
  );

  const requiredTopLevel = [
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
  ];

  for (const key of requiredTopLevel) {
    assert.equal(
      key in persisted,
      true,
      `serialized pending request is missing required key: ${key}`,
    );
  }

  const forbiddenTopLevel = [
    "requestId",
    "sessionId",
    "acpSessionId",
    "agentCommand",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "ownerPid",
    "ownerGeneration",
    "taskRequestId",
    "toolCall",
  ];

  for (const key of forbiddenTopLevel) {
    assert.equal(
      key in persisted,
      false,
      `serialized pending request must not emit camelCase key: ${key}`,
    );
  }
}

function assertPendingRequestSerializerSourceKeys(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.join(scriptDir, "..", "src", "session", "pending-requests.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  const serializerStart = source.indexOf("export function serializePendingRequestForDisk");
  assert.notEqual(serializerStart, -1, "serializePendingRequestForDisk not found");

  const serializerEnd = source.indexOf("\nfunction asRecord", serializerStart);
  assert.notEqual(serializerEnd, -1, "could not bound the pending request serializer block");
  const serializerBlock = source.slice(serializerStart, serializerEnd);

  const forbiddenPersistedKeys = [
    "requestId",
    "sessionId",
    "acpSessionId",
    "agentCommand",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "ownerPid",
    "ownerGeneration",
    "taskRequestId",
    "toolCallId",
    "rawInput",
    "answeredAt",
    "optionId",
  ];

  for (const key of forbiddenPersistedKeys) {
    const matcher = new RegExp(`\\b${key}\\s*:`, "g");
    assert.equal(
      matcher.test(serializerBlock),
      false,
      `pending request serializer contains non-snake persisted key literal: ${key}`,
    );
  }
}

assertSerializationPolicy();
assertSerializerSourceKeys();
assertPendingRequestSerializationPolicy();
assertPendingRequestSerializerSourceKeys();
