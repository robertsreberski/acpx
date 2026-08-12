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

/**
 * How a responder answers a parked request.
 *
 * The union is explicitly tagged. A later arm (an `accept` carrying content,
 * say) must be a new tag rather than a new key on an existing shape, because
 * key-sniffing would silently read the new arm as an old one. `option_id` is
 * spelled the way the stored entry spells it, so a responder can echo back an
 * id it read straight out of a listed entry.
 */
export type PendingRequestAnswer =
  | { type: "select"; option_id: string }
  | { type: "decline" }
  | { type: "cancel" };

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

/** Parse an answer that crossed a process boundary. Unknown tags are rejected. */
export function parsePendingRequestAnswer(value: unknown): PendingRequestAnswer | undefined {
  const record = asRecord(value);
  if (record?.type === "decline" || record?.type === "cancel") {
    return { type: record.type };
  }
  if (record?.type !== "select") {
    return undefined;
  }
  const optionId = asNonEmptyString(record.option_id);
  return optionId ? { type: "select", option_id: optionId } : undefined;
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

async function listPendingRequestFileNames(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

async function readParsedPendingRequestFile(file: string): Promise<PendingRequest | undefined> {
  try {
    return parsePendingRequest(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    // A half-written or corrupt entry must not hide the readable ones.
    return undefined;
  }
}

export async function listPendingRequests(
  sessionId: string,
  homeDir: string = os.homedir(),
): Promise<PendingRequest[]> {
  const dir = pendingRequestsSessionDir(sessionId, homeDir);
  const entries: PendingRequest[] = [];
  for (const name of await listPendingRequestFileNames(dir)) {
    const parsed = await readParsedPendingRequestFile(path.join(dir, name));
    if (parsed) {
      entries.push(parsed);
    }
  }
  return entries;
}

async function readPendingRequestDirSessionId(dir: string): Promise<string | undefined> {
  for (const name of await listPendingRequestFileNames(dir)) {
    const parsed = await readParsedPendingRequestFile(path.join(dir, name));
    if (parsed) {
      return parsed.sessionId;
    }
  }
  return undefined;
}

/**
 * Every session id the request store knows about.
 *
 * A session's directory name is a hash, so its id can only come from an entry
 * inside it. A directory whose entries are all unreadable stays invisible here
 * and is left for the owning session's own sweep to discard.
 */
export async function listPendingRequestSessionIds(
  homeDir: string = os.homedir(),
): Promise<string[]> {
  const base = pendingRequestsBaseDir(homeDir);
  let dirs: string[];
  try {
    dirs = await fs.readdir(base);
  } catch {
    return [];
  }

  const sessionIds = new Set<string>();
  for (const dir of dirs) {
    const sessionId = await readPendingRequestDirSessionId(path.join(base, dir));
    if (sessionId) {
      sessionIds.add(sessionId);
    }
  }
  return [...sessionIds];
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
  // Malformed files are invisible to listPendingRequests, so nothing else would
  // ever clear them. Entries carrying a schema we simply do not know are left
  // alone: an older acpx must never destroy a newer store.
  for (const name of await listMalformedPendingRequestFiles(params.sessionId, homeDir)) {
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

/**
 * A file is malformed when it is not JSON, not an object, or carries no schema
 * string at all. A recognisable-but-unknown schema (a future version) is NOT
 * malformed and must be preserved.
 */
function isMalformedPendingRequestPayload(payload: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return true;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return true;
  }
  const schema = (parsed as { schema?: unknown }).schema;
  if (typeof schema !== "string" || schema.length === 0) {
    return true;
  }
  // Our own schema must still parse cleanly; anything else is a future version.
  return schema === PENDING_REQUEST_SCHEMA && !parsePendingRequest(parsed);
}

async function listMalformedPendingRequestFiles(
  sessionId: string,
  homeDir: string,
): Promise<string[]> {
  const dir = pendingRequestsSessionDir(sessionId, homeDir);
  const malformed: string[] = [];
  for (const name of await listPendingRequestFileNames(dir)) {
    try {
      const payload = await fs.readFile(path.join(dir, name), "utf8");
      if (isMalformedPendingRequestPayload(payload)) {
        malformed.push(name);
      }
    } catch {
      malformed.push(name);
    }
  }
  return malformed;
}

export async function deletePendingRequestsForSession(
  sessionId: string,
  homeDir: string = os.homedir(),
): Promise<void> {
  await fs.rm(pendingRequestsSessionDir(sessionId, homeDir), { recursive: true, force: true });
}
