import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PermissionOption, ToolKind } from "@agentclientprotocol/sdk";
import { assertPersistedKeyPolicy } from "../persisted-key-policy.js";
import { createAtomicWriteTempPath } from "./persistence/atomic-write.js";

export const PENDING_REQUEST_SCHEMA = "acpx.pending_request.v1" as const;

/**
 * Lifecycle of a parked request. `pending` is the only non-terminal state; the
 * owner that parked it is the only writer that may move it to a terminal state.
 * `orphaned` is the one exception: any process may set it, and only after
 * confirming the recorded owner is gone (dead pid, or a generation that no
 * longer matches the live lease).
 */
export const PENDING_REQUEST_STATES = [
  "pending",
  "answered",
  "cancelled",
  "expired",
  "orphaned",
] as const;
export type PendingRequestState = (typeof PENDING_REQUEST_STATES)[number];

/** `elicitation` is reserved for a later milestone and is not accepted yet. */
export const PENDING_REQUEST_KINDS = ["permission"] as const;
export type PendingRequestKind = (typeof PENDING_REQUEST_KINDS)[number];

export const PENDING_REQUEST_RESOLUTION_SOURCES = ["cli", "expiry", "cancel", "shutdown"] as const;
export type PendingRequestResolutionSource = (typeof PENDING_REQUEST_RESOLUTION_SOURCES)[number];

export type PendingRequestOption = {
  optionId: string;
  name: string;
  kind: PermissionOption["kind"];
};

export type PendingRequestToolCall = {
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  rawInput?: unknown;
};

export type PendingRequestResolution = {
  answeredAt: string;
  source: PendingRequestResolutionSource;
  optionId?: string;
  action?: string;
};

export type PendingRequest = {
  schema: typeof PENDING_REQUEST_SCHEMA;
  requestId: string;
  /** acpx session record id; also the on-disk directory for this session. */
  sessionId: string;
  acpSessionId: string;
  agentCommand: string;
  cwd: string;
  kind: PendingRequestKind;
  state: PendingRequestState;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  ownerPid: number;
  ownerGeneration: number;
  taskRequestId: string;
  toolCall: PendingRequestToolCall;
  /**
   * The agent's full option list, verbatim. A responder echoes one of these ids
   * back, so trimming or normalizing the list would make adapter-specific sets
   * (plan mode, for example) unanswerable.
   */
  options: PendingRequestOption[];
  resolution?: PendingRequestResolution;
};

export function isTerminalPendingRequestState(state: PendingRequestState): boolean {
  return state !== "pending";
}

export function pendingRequestsBaseDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".acpx", "requests");
}

/**
 * Session ids are opaque and may contain path separators, so the directory name
 * is a hash rather than the id itself. The id is still recorded inside every
 * entry, so a directory remains attributable.
 */
export function pendingRequestsSessionDir(
  sessionId: string,
  homeDir: string = os.homedir(),
): string {
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return path.join(pendingRequestsBaseDir(homeDir), key);
}

export function pendingRequestFilePath(
  sessionId: string,
  requestId: string,
  homeDir: string = os.homedir(),
): string {
  return path.join(
    pendingRequestsSessionDir(sessionId, homeDir),
    `${encodeURIComponent(requestId)}.json`,
  );
}

export function serializePendingRequestForDisk(entry: PendingRequest): Record<string, unknown> {
  return {
    schema: PENDING_REQUEST_SCHEMA,
    request_id: entry.requestId,
    session_id: entry.sessionId,
    acp_session_id: entry.acpSessionId,
    agent_command: entry.agentCommand,
    cwd: entry.cwd,
    kind: entry.kind,
    state: entry.state,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    ...(entry.expiresAt ? { expires_at: entry.expiresAt } : {}),
    owner_pid: entry.ownerPid,
    owner_generation: entry.ownerGeneration,
    task_request_id: entry.taskRequestId,
    tool_call: {
      tool_call_id: entry.toolCall.toolCallId,
      title: entry.toolCall.title,
      ...(entry.toolCall.kind ? { kind: entry.toolCall.kind } : {}),
      ...(entry.toolCall.rawInput !== undefined ? { raw_input: entry.toolCall.rawInput } : {}),
    },
    options: entry.options.map((option) => ({
      option_id: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
    ...(entry.resolution
      ? {
          resolution: {
            answered_at: entry.resolution.answeredAt,
            source: entry.resolution.source,
            ...(entry.resolution.optionId ? { option_id: entry.resolution.optionId } : {}),
            ...(entry.resolution.action ? { action: entry.resolution.action } : {}),
          },
        }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseOption(raw: unknown): PendingRequestOption | undefined {
  const record = asRecord(raw);
  const optionId = asNonEmptyString(record?.option_id);
  const name = asNonEmptyString(record?.name);
  const kind = asNonEmptyString(record?.kind);
  if (!optionId || !name || !kind) {
    return undefined;
  }
  return { optionId, name, kind: kind as PermissionOption["kind"] };
}

function parseOptions(value: unknown): PendingRequestOption[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const options: PendingRequestOption[] = [];
  for (const raw of value) {
    const option = parseOption(raw);
    if (!option) {
      return undefined;
    }
    options.push(option);
  }
  return options;
}

function parseToolCall(value: unknown): PendingRequestToolCall | undefined {
  const record = asRecord(value);
  const toolCallId = asNonEmptyString(record?.tool_call_id);
  const title = asNonEmptyString(record?.title);
  if (!record || !toolCallId || !title) {
    return undefined;
  }
  const kind = asNonEmptyString(record.kind);
  return {
    toolCallId,
    title,
    ...(kind ? { kind: kind as ToolKind } : {}),
    ...(record.raw_input !== undefined ? { rawInput: record.raw_input } : {}),
  };
}

function isResolutionSource(value: unknown): value is PendingRequestResolutionSource {
  return (
    typeof value === "string" &&
    PENDING_REQUEST_RESOLUTION_SOURCES.includes(value as PendingRequestResolutionSource)
  );
}

function parseResolution(value: unknown): PendingRequestResolution | undefined {
  const record = asRecord(value);
  const answeredAt = asNonEmptyString(record?.answered_at);
  if (!record || !answeredAt || !isResolutionSource(record.source)) {
    return undefined;
  }
  const optionId = asNonEmptyString(record.option_id);
  const action = asNonEmptyString(record.action);
  return {
    answeredAt,
    source: record.source,
    ...(optionId ? { optionId } : {}),
    ...(action ? { action } : {}),
  };
}

/** Absent resolution is valid; a present-but-malformed one is not. */
function parseOptionalResolution(
  value: unknown,
): { ok: true; resolution?: PendingRequestResolution } | { ok: false } {
  if (value === undefined) {
    return { ok: true };
  }
  const resolution = parseResolution(value);
  return resolution ? { ok: true, resolution } : { ok: false };
}

type RequiredScalars = Pick<
  PendingRequest,
  | "requestId"
  | "sessionId"
  | "acpSessionId"
  | "agentCommand"
  | "cwd"
  | "createdAt"
  | "updatedAt"
  | "taskRequestId"
>;

const REQUIRED_SCALAR_KEYS = {
  requestId: "request_id",
  sessionId: "session_id",
  acpSessionId: "acp_session_id",
  agentCommand: "agent_command",
  cwd: "cwd",
  createdAt: "created_at",
  updatedAt: "updated_at",
  taskRequestId: "task_request_id",
} as const satisfies Record<keyof RequiredScalars, string>;

function parseRequiredScalars(record: Record<string, unknown>): RequiredScalars | undefined {
  const scalars: Partial<RequiredScalars> = {};
  for (const [field, key] of Object.entries(REQUIRED_SCALAR_KEYS)) {
    const value = asNonEmptyString(record[key]);
    if (!value) {
      return undefined;
    }
    scalars[field as keyof RequiredScalars] = value;
  }
  return scalars as RequiredScalars;
}

type PendingRequestEnums = { kind: PendingRequestKind; state: PendingRequestState };

function parseEnums(record: Record<string, unknown>): PendingRequestEnums | undefined {
  const kind = asNonEmptyString(record.kind);
  const state = asNonEmptyString(record.state);
  if (!kind || !PENDING_REQUEST_KINDS.includes(kind as PendingRequestKind)) {
    return undefined;
  }
  if (!state || !PENDING_REQUEST_STATES.includes(state as PendingRequestState)) {
    return undefined;
  }
  return { kind: kind as PendingRequestKind, state: state as PendingRequestState };
}

type PendingRequestOwner = Pick<PendingRequest, "ownerPid" | "ownerGeneration">;

function parseOwner(record: Record<string, unknown>): PendingRequestOwner | undefined {
  const ownerPid = record.owner_pid;
  const ownerGeneration = record.owner_generation;
  if (!Number.isInteger(ownerPid) || !Number.isInteger(ownerGeneration)) {
    return undefined;
  }
  return { ownerPid: ownerPid as number, ownerGeneration: ownerGeneration as number };
}

type PendingRequestParts = RequiredScalars &
  PendingRequestEnums &
  PendingRequestOwner &
  Pick<PendingRequest, "toolCall" | "options">;

function parsePendingRequestParts(
  record: Record<string, unknown>,
): PendingRequestParts | undefined {
  const scalars = parseRequiredScalars(record);
  const enums = parseEnums(record);
  const owner = parseOwner(record);
  const toolCall = parseToolCall(record.tool_call);
  const options = parseOptions(record.options);
  if (!scalars || !enums || !owner || !toolCall || !options) {
    return undefined;
  }
  return { ...scalars, ...enums, ...owner, toolCall, options };
}

export function parsePendingRequest(value: unknown): PendingRequest | undefined {
  const record = asRecord(value);
  if (!record || record.schema !== PENDING_REQUEST_SCHEMA) {
    return undefined;
  }

  const parts = parsePendingRequestParts(record);
  const resolution = parseOptionalResolution(record.resolution);
  if (!parts || !resolution.ok) {
    return undefined;
  }

  const expiresAt = asNonEmptyString(record.expires_at);
  return {
    schema: PENDING_REQUEST_SCHEMA,
    ...parts,
    ...(expiresAt ? { expiresAt } : {}),
    ...(resolution.resolution ? { resolution: resolution.resolution } : {}),
  };
}

export async function writePendingRequest(
  entry: PendingRequest,
  homeDir: string = os.homedir(),
): Promise<void> {
  const persisted = serializePendingRequestForDisk(entry);
  assertPersistedKeyPolicy(persisted);

  const dir = pendingRequestsSessionDir(entry.sessionId, homeDir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const file = pendingRequestFilePath(entry.sessionId, entry.requestId, homeDir);
  const tempFile = createAtomicWriteTempPath(file);
  await fs.writeFile(tempFile, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  await fs.rename(tempFile, file);
}

export async function readPendingRequest(
  sessionId: string,
  requestId: string,
  homeDir: string = os.homedir(),
): Promise<PendingRequest | undefined> {
  try {
    const payload = await fs.readFile(
      pendingRequestFilePath(sessionId, requestId, homeDir),
      "utf8",
    );
    return parsePendingRequest(JSON.parse(payload));
  } catch {
    return undefined;
  }
}

export async function listPendingRequests(
  sessionId: string,
  homeDir: string = os.homedir(),
): Promise<PendingRequest[]> {
  const dir = pendingRequestsSessionDir(sessionId, homeDir);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const entries: PendingRequest[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      const payload = await fs.readFile(path.join(dir, name), "utf8");
      const parsed = parsePendingRequest(JSON.parse(payload));
      if (parsed) {
        entries.push(parsed);
      }
    } catch {
      // A half-written or corrupt entry must not hide the readable ones.
    }
  }
  return entries;
}

export const PENDING_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type PendingRequestSweepResult = {
  orphaned: PendingRequest[];
  pruned: string[];
  /** Files that could not be parsed and were removed. */
  discarded: string[];
};

/**
 * Reconcile a session's request directory with the owner that is starting.
 *
 * Entries still marked pending but stamped with a different owner generation
 * cannot be answered by anyone — their waiter died with the previous owner — so
 * they are marked orphaned. This is the one transition a process other than the
 * parking owner may perform, and only because the generation proves the owner
 * is gone. Terminal entries older than the retention window are deleted.
 */
export async function sweepPendingRequests(params: {
  sessionId: string;
  ownerGeneration: number;
  now?: Date;
  retentionMs?: number;
  homeDir?: string;
}): Promise<PendingRequestSweepResult> {
  const homeDir = params.homeDir ?? os.homedir();
  const now = params.now ?? new Date();
  const retentionMs = params.retentionMs ?? PENDING_REQUEST_RETENTION_MS;
  const cutoff = new Date(now.getTime() - retentionMs).toISOString();

  const result: PendingRequestSweepResult = { orphaned: [], pruned: [], discarded: [] };
  // Unparseable files are invisible to listPendingRequests, so nothing else
  // would ever clear them. They cannot be answered, so they are dropped.
  for (const name of await listUnparseablePendingRequestFiles(params.sessionId, homeDir)) {
    await fs
      .rm(path.join(pendingRequestsSessionDir(params.sessionId, homeDir), name), { force: true })
      .catch(() => undefined);
    result.discarded.push(name);
  }
  for (const entry of await listPendingRequests(params.sessionId, homeDir)) {
    await sweepPendingRequestEntry(entry, {
      ownerGeneration: params.ownerGeneration,
      now,
      cutoff,
      homeDir,
      result,
    });
  }
  return result;
}

async function sweepPendingRequestEntry(
  entry: PendingRequest,
  params: {
    ownerGeneration: number;
    now: Date;
    cutoff: string;
    homeDir: string;
    result: PendingRequestSweepResult;
  },
): Promise<void> {
  if (entry.state === "pending") {
    if (entry.ownerGeneration === params.ownerGeneration) {
      return;
    }
    const answeredAt = params.now.toISOString();
    const orphaned: PendingRequest = {
      ...entry,
      state: "orphaned",
      updatedAt: answeredAt,
      resolution: { answeredAt, source: "shutdown" },
    };
    await writePendingRequest(orphaned, params.homeDir).catch(() => undefined);
    params.result.orphaned.push(orphaned);
    return;
  }

  if (entry.updatedAt < params.cutoff) {
    await fs
      .rm(pendingRequestFilePath(entry.sessionId, entry.requestId, params.homeDir), {
        force: true,
      })
      .catch(() => undefined);
    params.result.pruned.push(entry.requestId);
  }
}

async function listUnparseablePendingRequestFiles(
  sessionId: string,
  homeDir: string,
): Promise<string[]> {
  const dir = pendingRequestsSessionDir(sessionId, homeDir);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const unparseable: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      const payload = await fs.readFile(path.join(dir, name), "utf8");
      if (!parsePendingRequest(JSON.parse(payload))) {
        unparseable.push(name);
      }
    } catch {
      unparseable.push(name);
    }
  }
  return unparseable;
}

export async function deletePendingRequestsForSession(
  sessionId: string,
  homeDir: string = os.homedir(),
): Promise<void> {
  await fs.rm(pendingRequestsSessionDir(sessionId, homeDir), { recursive: true, force: true });
}
