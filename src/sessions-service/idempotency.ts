import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isProcessAlive } from "../process-liveness.js";
import type { AcpxMutationOperation, AcpxMutationReceipt } from "./contract.js";

const IDEMPOTENCY_SCHEMA = "acpx.session_mutation.v1" as const;
const RECOVERY_INDEX_SCHEMA = "acpx.session_mutation_recovery.v1" as const;
const SESSION_INDEX_SCHEMA = "acpx.session_mutation_session.v1" as const;
const RETIRED_KEYS_SCHEMA = "acpx.session_mutation_retired.v1" as const;
const LOCK_RETRY_MS = 20;
const DEFAULT_MAX_RECEIPTS = 1_024;
const DEFAULT_MAX_TERMINAL_RECEIPTS = 512;
const DEFAULT_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_RECOVERY_CANDIDATES = 32;
// Replayable result receipts live for seven days (or the latest 512 terminal
// actions). Compacted keys then remain exact tombstones for another 30 days.
// This explicit retention contract gives callers at least 30 days of exact
// idempotency without an unbounded ledger or probabilistic false positives.
const RETIRED_KEY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_RETIRED_KEYS_PER_SHARD = 1_024;
const MUTATION_OPERATIONS = new Set<AcpxMutationOperation>([
  "create_session",
  "adopt_session",
  "enqueue_prompt",
  "cancel_turn",
  "close_session",
  "respond_pending_request",
]);

type StoredMutation = {
  schema: typeof IDEMPOTENCY_SCHEMA;
  idempotency_key: string;
  operation: AcpxMutationOperation;
  fingerprint: string;
  state: "started" | "succeeded" | "failed" | "pruned";
  created_at: string;
  updated_at: string;
  pid: number;
  acpx_record_id?: string;
  recovery_scope?: string;
  recovery_result?: unknown;
  result?: unknown;
  error?: { name: string; message: string };
};

type RecoveryIndex = {
  schema: typeof RECOVERY_INDEX_SCHEMA;
  operation: AcpxMutationOperation;
  scope_hash: string;
  keys: string[];
};

type SessionReceiptIndex = {
  schema: typeof SESSION_INDEX_SCHEMA;
  acpx_record_id: string;
  keys: string[];
};

type RetiredKeys = {
  schema: typeof RETIRED_KEYS_SCHEMA;
  prefix: string;
  entries: Array<{ key_hash: string; expires_at: string }>;
};

type LedgerIndex = {
  schema: "acpx.session_mutation_ledger.v1";
  entries: Array<{
    key: string;
    state: "started" | "succeeded" | "failed";
    updated_at: string;
  }>;
};

type MutationLock = { filePath: string };

export class AcpxIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_CONFLICT";

  constructor(idempotencyKey: string) {
    super(
      `Idempotency key ${JSON.stringify(idempotencyKey)} was already used for another mutation`,
    );
    this.name = "AcpxIdempotencyConflictError";
  }
}

export class AcpxIdempotencyInDoubtError extends Error {
  readonly code = "IDEMPOTENCY_RESULT_UNKNOWN";

  constructor(idempotencyKey: string, operation: AcpxMutationOperation) {
    super(
      `Mutation ${operation} for idempotency key ${JSON.stringify(idempotencyKey)} started, ` +
        "but its durable result is unavailable; inspect the session before choosing a new key",
    );
    this.name = "AcpxIdempotencyInDoubtError";
  }
}

export class AcpxIdempotencyCorruptError extends Error {
  readonly code = "IDEMPOTENCY_RECORD_CORRUPT";

  constructor(idempotencyKey: string) {
    super(
      `The durable mutation record for idempotency key ${JSON.stringify(idempotencyKey)} is ` +
        "invalid; the mutation will not be repeated because its prior result is unknown",
    );
    this.name = "AcpxIdempotencyCorruptError";
  }
}

export class AcpxIdempotentMutationError extends Error {
  readonly code = "IDEMPOTENT_MUTATION_FAILED";

  constructor(
    idempotencyKey: string,
    operation: AcpxMutationOperation,
    prior: { name: string; message: string },
  ) {
    super(
      `Mutation ${operation} for idempotency key ${JSON.stringify(idempotencyKey)} previously ` +
        `failed with ${prior.name}: ${prior.message}`,
    );
    this.name = "AcpxIdempotentMutationError";
  }
}

export class AcpxIdempotencyRetiredError extends Error {
  readonly code = "IDEMPOTENCY_RECEIPT_RETIRED";

  constructor(idempotencyKey: string) {
    super(
      `The durable result for idempotency key ${JSON.stringify(idempotencyKey)} was compacted; ` +
        "the mutation will not be repeated because its prior result is no longer available",
    );
    this.name = "AcpxIdempotencyRetiredError";
  }
}

export class AcpxIdempotencySessionPrunedError extends Error {
  readonly code = "IDEMPOTENCY_SESSION_PRUNED";

  constructor(idempotencyKey: string, acpxRecordId: string) {
    super(
      `Idempotency key ${JSON.stringify(idempotencyKey)} belongs to pruned session ` +
        `${JSON.stringify(acpxRecordId)}; the old session result will not be replayed`,
    );
    this.name = "AcpxIdempotencySessionPrunedError";
  }
}

export class AcpxIdempotencyLedgerFullError extends Error {
  readonly code = "IDEMPOTENCY_LEDGER_FULL";

  constructor(limit: number) {
    super(
      `The durable mutation ledger reached its safe limit of ${limit} active receipts; ` +
        "resolve incomplete mutations before submitting another mutation",
    );
    this.name = "AcpxIdempotencyLedgerFullError";
  }
}

function baseDir(): string {
  return path.join(os.homedir(), ".acpx", "session-service", "idempotency");
}

function keyHash(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

function mutationPath(idempotencyKey: string): string {
  return path.join(baseDir(), `${keyHash(idempotencyKey)}.json`);
}

function lockPath(idempotencyKey: string): string {
  return path.join(baseDir(), `${keyHash(idempotencyKey)}.lock`);
}

function recoveryLockPath(scopeHash: string): string {
  return path.join(baseDir(), `${scopeHash}.recovery.lock`);
}

function recoveryIndexPath(scopeHash: string): string {
  return path.join(baseDir(), "recovery", `${scopeHash}.json`);
}

function sessionIndexPath(acpxRecordId: string): string {
  return path.join(baseDir(), "sessions", `${keyHash(acpxRecordId)}.json`);
}

function retiredKeysPath(prefix: string): string {
  return path.join(baseDir(), "retired", `${prefix}.json`);
}

function maintenanceLockPath(): string {
  return path.join(baseDir(), "maintenance.lock");
}

function ledgerIndexPath(): string {
  return path.join(baseDir(), "ledger-index.json");
}

function migrationMarkerPath(): string {
  return path.join(baseDir(), "indexes-v1.complete");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function assertIdempotencyKey(value: string): void {
  if (!value.trim() || value.length > 256) {
    throw new Error("idempotencyKey must contain 1 to 256 characters");
  }
}

// oxlint-disable-next-line eslint/complexity -- Fail-closed validation intentionally checks every durable field before replay.
async function readStored(idempotencyKey: string): Promise<StoredMutation | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(mutationPath(idempotencyKey), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AcpxIdempotencyCorruptError(idempotencyKey);
    }
    const record = value as Record<string, unknown>;
    if (
      record.schema !== IDEMPOTENCY_SCHEMA ||
      record.idempotency_key !== idempotencyKey ||
      !MUTATION_OPERATIONS.has(record.operation as AcpxMutationOperation) ||
      typeof record.fingerprint !== "string" ||
      typeof record.created_at !== "string" ||
      typeof record.updated_at !== "string" ||
      typeof record.pid !== "number" ||
      (record.acpx_record_id !== undefined && typeof record.acpx_record_id !== "string") ||
      (record.recovery_scope !== undefined && typeof record.recovery_scope !== "string") ||
      (record.state !== "started" &&
        record.state !== "succeeded" &&
        record.state !== "failed" &&
        record.state !== "pruned")
    ) {
      throw new AcpxIdempotencyCorruptError(idempotencyKey);
    }
    return value as StoredMutation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    if (error instanceof AcpxIdempotencyCorruptError) {
      throw error;
    }
    throw new AcpxIdempotencyCorruptError(idempotencyKey);
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
}

async function writeStored(idempotencyKey: string, value: StoredMutation): Promise<void> {
  await fs.mkdir(baseDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(baseDir(), 0o700);
  await writeJsonAtomic(mutationPath(idempotencyKey), value);
}

function emptyRetiredKeys(prefix: string): RetiredKeys {
  return { schema: RETIRED_KEYS_SCHEMA, prefix, entries: [] };
}

function isRetiredKeyEntry(value: unknown): value is RetiredKeys["entries"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.key_hash === "string" &&
    /^[a-f0-9]{64}$/u.test(entry.key_hash) &&
    typeof entry.expires_at === "string" &&
    Number.isFinite(Date.parse(entry.expires_at))
  );
}

// oxlint-disable-next-line eslint/complexity -- Exact tombstone parsing validates every durable field and purges expiry fail closed.
async function readRetiredKeys(prefix: string): Promise<{ value: RetiredKeys; changed: boolean }> {
  try {
    const parsed = JSON.parse(await fs.readFile(retiredKeysPath(prefix), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid retired keys");
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.schema !== RETIRED_KEYS_SCHEMA ||
      record.prefix !== prefix ||
      !Array.isArray(record.entries) ||
      !record.entries.every(isRetiredKeyEntry)
    ) {
      throw new Error("invalid retired keys");
    }
    const entries = record.entries;
    const now = new Date().toISOString();
    const retained = entries.filter((entry) => entry.expires_at > now);
    if (retained.length > MAX_RETIRED_KEYS_PER_SHARD) {
      throw new AcpxIdempotencyLedgerFullError(MAX_RETIRED_KEYS_PER_SHARD);
    }
    return {
      value: { schema: RETIRED_KEYS_SCHEMA, prefix, entries: retained },
      changed: retained.length !== entries.length,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { value: emptyRetiredKeys(prefix), changed: false };
    }
    if (error instanceof AcpxIdempotencyLedgerFullError) {
      throw error;
    }
    throw new Error("The durable idempotency retired-key set is corrupt", { cause: error });
  }
}

function retiredKeyHash(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

function addRetiredHashes(retired: RetiredKeys, hashes: string[]): RetiredKeys {
  const expiresAt = new Date(Date.now() + RETIRED_KEY_RETENTION_MS).toISOString();
  const byHash = new Map(retired.entries.map((entry) => [entry.key_hash, entry]));
  for (const hash of hashes) {
    byHash.set(hash, { key_hash: hash, expires_at: expiresAt });
  }
  if (byHash.size > MAX_RETIRED_KEYS_PER_SHARD) {
    throw new AcpxIdempotencyLedgerFullError(MAX_RETIRED_KEYS_PER_SHARD);
  }
  return { ...retired, entries: [...byHash.values()] };
}

function retiredHashesByPrefix(keys: string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const key of keys) {
    const hash = retiredKeyHash(key);
    const prefix = hash.slice(0, 2);
    grouped.set(prefix, [...(grouped.get(prefix) ?? []), hash]);
  }
  return grouped;
}

async function assertRetirementCapacity(keys: string[]): Promise<void> {
  for (const [prefix, hashes] of retiredHashesByPrefix(keys)) {
    addRetiredHashes((await readRetiredKeys(prefix)).value, hashes);
  }
}

async function persistRetiredKeys(keys: string[]): Promise<void> {
  for (const [prefix, hashes] of retiredHashesByPrefix(keys)) {
    const retired = await readRetiredKeys(prefix);
    await writeJsonAtomic(retiredKeysPath(prefix), addRetiredHashes(retired.value, hashes));
  }
}

async function assertKeyNotRetired(idempotencyKey: string): Promise<void> {
  const hash = retiredKeyHash(idempotencyKey);
  const prefix = hash.slice(0, 2);
  const retired = await readRetiredKeys(prefix);
  if (retired.value.entries.some((entry) => entry.key_hash === hash)) {
    throw new AcpxIdempotencyRetiredError(idempotencyKey);
  }
}

function extractAcpxRecordId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.acpxRecordId === "string") {
    return record.acpxRecordId;
  }
  if (typeof record.recordId === "string") {
    return record.recordId;
  }
  return extractAcpxRecordId(record.session);
}

async function readStringIndex<T>(
  filePath: string,
  validate: (value: unknown) => value is T,
): Promise<T | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!validate(value)) {
      throw new Error(`Invalid idempotency index ${filePath}`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isRecoveryIndex(
  value: unknown,
  operation: AcpxMutationOperation,
  scopeHash: string,
): value is RecoveryIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schema === RECOVERY_INDEX_SCHEMA &&
    record.operation === operation &&
    record.scope_hash === scopeHash &&
    Array.isArray(record.keys) &&
    record.keys.every((key) => typeof key === "string")
  );
}

async function addRecoveryCandidate(
  operation: AcpxMutationOperation,
  scopeHash: string,
  idempotencyKey: string,
): Promise<void> {
  const filePath = recoveryIndexPath(scopeHash);
  const current = await readStringIndex(filePath, (value): value is RecoveryIndex =>
    isRecoveryIndex(value, operation, scopeHash),
  );
  const keys = [...new Set([...(current?.keys ?? []), idempotencyKey])];
  if (keys.length > MAX_RECOVERY_CANDIDATES) {
    throw new AcpxIdempotencyInDoubtError(idempotencyKey, operation);
  }
  await writeJsonAtomic(filePath, {
    schema: RECOVERY_INDEX_SCHEMA,
    operation,
    scope_hash: scopeHash,
    keys,
  } satisfies RecoveryIndex);
}

async function removeRecoveryCandidates(
  scopeHash: string | undefined,
  keys: string[],
): Promise<void> {
  if (!scopeHash) {
    return;
  }
  const filePath = recoveryIndexPath(scopeHash);
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid idempotency recovery index ${filePath}`);
  }
  const current = value as RecoveryIndex;
  const removed = new Set(keys);
  const remaining = current.keys.filter((key) => !removed.has(key));
  if (remaining.length === 0) {
    await fs.unlink(filePath).catch(() => undefined);
  } else {
    await writeJsonAtomic(filePath, { ...current, keys: remaining });
  }
}

function isSessionReceiptIndex(value: unknown, acpxRecordId: string): value is SessionReceiptIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schema === SESSION_INDEX_SCHEMA &&
    record.acpx_record_id === acpxRecordId &&
    Array.isArray(record.keys) &&
    record.keys.every((key) => typeof key === "string")
  );
}

async function addSessionReceipt(acpxRecordId: string, idempotencyKey: string): Promise<void> {
  const filePath = sessionIndexPath(acpxRecordId);
  const lock = await acquireLockAt(`${filePath}.lock`);
  try {
    const current = await readStringIndex(filePath, (value): value is SessionReceiptIndex =>
      isSessionReceiptIndex(value, acpxRecordId),
    );
    await writeJsonAtomic(filePath, {
      schema: SESSION_INDEX_SCHEMA,
      acpx_record_id: acpxRecordId,
      keys: [...new Set([...(current?.keys ?? []), idempotencyKey])],
    } satisfies SessionReceiptIndex);
  } finally {
    await releaseLock(lock);
  }
}

async function removeSessionReceipt(acpxRecordId: string, idempotencyKey: string): Promise<void> {
  const filePath = sessionIndexPath(acpxRecordId);
  const lock = await acquireLockAt(`${filePath}.lock`);
  try {
    const current = await readStringIndex(filePath, (value): value is SessionReceiptIndex =>
      isSessionReceiptIndex(value, acpxRecordId),
    );
    if (!current) {
      return;
    }
    const keys = current.keys.filter((key) => key !== idempotencyKey);
    if (keys.length === 0) {
      await fs.unlink(filePath).catch(() => undefined);
    } else {
      await writeJsonAtomic(filePath, { ...current, keys });
    }
  } finally {
    await releaseLock(lock);
  }
}

function isLedgerIndex(value: unknown): value is LedgerIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schema === "acpx.session_mutation_ledger.v1" &&
    Array.isArray(record.entries) &&
    record.entries.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }
      const item = entry as Record<string, unknown>;
      return (
        typeof item.key === "string" &&
        (item.state === "started" || item.state === "succeeded" || item.state === "failed") &&
        typeof item.updated_at === "string"
      );
    })
  );
}

async function readLedgerIndex(): Promise<LedgerIndex> {
  return (
    (await readStringIndex(ledgerIndexPath(), isLedgerIndex)) ?? {
      schema: "acpx.session_mutation_ledger.v1",
      entries: [],
    }
  );
}

// oxlint-disable-next-line eslint/complexity -- Migration validates the complete legacy durable receipt before indexing it.
async function readLegacyStoredFile(filePath: string): Promise<StoredMutation> {
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid legacy idempotency receipt ${filePath}`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.schema !== IDEMPOTENCY_SCHEMA ||
    typeof record.idempotency_key !== "string" ||
    !MUTATION_OPERATIONS.has(record.operation as AcpxMutationOperation) ||
    (record.state !== "started" && record.state !== "succeeded" && record.state !== "failed") ||
    typeof record.updated_at !== "string"
  ) {
    throw new Error(`Invalid legacy idempotency receipt ${filePath}`);
  }
  return value as StoredMutation;
}

/** Rebuild exact lookup indexes once for fork.3 receipts written before indexes existed. */
// oxlint-disable-next-line eslint/complexity -- One-time migration separates marker races, directory I/O, recovery conflicts, and session binding.
async function migrateLegacyReceiptsIfNeeded(): Promise<void> {
  try {
    await fs.access(migrationMarkerPath());
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const lock = await acquireLockAt(maintenanceLockPath());
  try {
    try {
      await fs.access(migrationMarkerPath());
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    let files: string[];
    try {
      files = await fs.readdir(baseDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        files = [];
      } else {
        throw error;
      }
    }
    const receipts: StoredMutation[] = [];
    for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))) {
      receipts.push(await readLegacyStoredFile(path.join(baseDir(), file)));
    }
    const recovery = new Map<string, RecoveryIndex>();
    const sessions = new Map<string, SessionReceiptIndex>();
    for (const receipt of receipts) {
      if (receipt.state === "started" && receipt.recovery_scope) {
        const current = recovery.get(receipt.recovery_scope);
        if (current && current.operation !== receipt.operation) {
          throw new Error(`Conflicting legacy recovery scope ${receipt.recovery_scope}`);
        }
        recovery.set(receipt.recovery_scope, {
          schema: RECOVERY_INDEX_SCHEMA,
          operation: receipt.operation,
          scope_hash: receipt.recovery_scope,
          keys: [...new Set([...(current?.keys ?? []), receipt.idempotency_key])],
        });
      }
      const acpxRecordId =
        receipt.acpx_record_id ??
        extractAcpxRecordId(receipt.recovery_result) ??
        extractAcpxRecordId(receipt.result);
      if (acpxRecordId) {
        receipt.acpx_record_id = acpxRecordId;
        await writeStored(receipt.idempotency_key, receipt);
        const current = sessions.get(acpxRecordId);
        sessions.set(acpxRecordId, {
          schema: SESSION_INDEX_SCHEMA,
          acpx_record_id: acpxRecordId,
          keys: [...new Set([...(current?.keys ?? []), receipt.idempotency_key])],
        });
      }
    }
    for (const [scopeHash, index] of recovery) {
      await writeJsonAtomic(recoveryIndexPath(scopeHash), index);
    }
    for (const [acpxRecordId, index] of sessions) {
      await writeJsonAtomic(sessionIndexPath(acpxRecordId), index);
    }
    await writeJsonAtomic(ledgerIndexPath(), {
      schema: "acpx.session_mutation_ledger.v1",
      entries: receipts.map((receipt) => ({
        key: receipt.idempotency_key,
        state: receipt.state as "started" | "succeeded" | "failed",
        updated_at: receipt.updated_at,
      })),
    } satisfies LedgerIndex);
    await fs.writeFile(migrationMarkerPath(), "v1\n", { encoding: "utf8", mode: 0o600 });
  } finally {
    await releaseLock(lock);
  }
}

async function ensureMigrationMarker(): Promise<void> {
  try {
    await fs.access(migrationMarkerPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await fs.writeFile(migrationMarkerPath(), "v1\n", { encoding: "utf8", mode: 0o600 });
  }
}

async function unlinkReceipts(keys: string[]): Promise<void> {
  for (const key of keys) {
    await fs.unlink(mutationPath(key)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
  }
}

async function updateLedgerEntry(
  key: string,
  state: "started" | "succeeded" | "failed",
  updatedAt: string,
): Promise<void> {
  const lock = await acquireLockAt(maintenanceLockPath());
  try {
    await ensureMigrationMarker();
    const ledger = await readLedgerIndex();
    const without = ledger.entries.filter((entry) => entry.key !== key);
    const next = [...without, { key, state, updated_at: updatedAt }];
    const cutoff = new Date(Date.now() - DEFAULT_TERMINAL_RETENTION_MS).toISOString();
    const terminal = next
      .filter((entry) => entry.state !== "started")
      .toSorted((left, right) => left.updated_at.localeCompare(right.updated_at));
    const retire = terminal.filter(
      (entry, index) =>
        entry.updated_at < cutoff || index < terminal.length - DEFAULT_MAX_TERMINAL_RECEIPTS,
    );
    const retiringKeys = new Set(retire.map((entry) => entry.key));
    const retained = next.filter((entry) => !retiringKeys.has(entry.key));
    if (retained.length > DEFAULT_MAX_RECEIPTS) {
      throw new AcpxIdempotencyLedgerFullError(DEFAULT_MAX_RECEIPTS);
    }
    if (retire.length > 0) {
      const retireKeys = retire.map((entry) => entry.key);
      await assertRetirementCapacity(retireKeys);
      await persistRetiredKeys(retireKeys);
      await unlinkReceipts(retire.map((entry) => entry.key));
    }
    await writeJsonAtomic(ledgerIndexPath(), { ...ledger, entries: retained });
  } finally {
    await releaseLock(lock);
  }
}

async function removeLedgerEntries(keys: string[]): Promise<void> {
  const lock = await acquireLockAt(maintenanceLockPath());
  try {
    const ledger = await readLedgerIndex();
    const removed = new Set(keys);
    await assertRetirementCapacity(keys);
    await persistRetiredKeys(keys);
    await unlinkReceipts(keys);
    await writeJsonAtomic(ledgerIndexPath(), {
      ...ledger,
      entries: ledger.entries.filter((entry) => !removed.has(entry.key)),
    });
  } finally {
    await releaseLock(lock);
  }
}

async function bindStoredMutationToSession(
  stored: StoredMutation,
  idempotencyKey: string,
  value: unknown,
): Promise<void> {
  const acpxRecordId = stored.acpx_record_id ?? extractAcpxRecordId(value);
  if (!acpxRecordId || stored.acpx_record_id === acpxRecordId) {
    return;
  }
  // Index first: a crash can leave a harmless index entry for an incomplete
  // receipt, but must never leave a replayable session receipt invisible to
  // pruning.
  await addSessionReceipt(acpxRecordId, idempotencyKey);
  stored.acpx_record_id = acpxRecordId;
  await writeStored(idempotencyKey, stored);
}

/**
 * Retire every mutation receipt tied to a session before its durable record is
 * pruned. Retired keys remain in a fixed-size fail-closed membership filter, so
 * an old create/adopt request can never replay a phantom deleted session.
 */
export async function retireIdempotencyReceiptsForSession(acpxRecordId: string): Promise<void> {
  await migrateLegacyReceiptsIfNeeded();
  const filePath = sessionIndexPath(acpxRecordId);
  const lock = await acquireLockAt(`${filePath}.lock`);
  let keys: string[];
  try {
    const index = await readStringIndex(filePath, (value): value is SessionReceiptIndex =>
      isSessionReceiptIndex(value, acpxRecordId),
    );
    if (!index) {
      return;
    }
    keys = index.keys;
  } finally {
    await releaseLock(lock);
  }
  // Session pruning runs only for closed records, so no new mutation can bind
  // after this snapshot. Acquire all receipt locks in deterministic order and
  // hold them through tombstone persistence and receipt unlinking: replay of a
  // soon-pruned result must not race the prune boundary.
  const receiptLocks: MutationLock[] = [];
  try {
    for (const key of keys.toSorted()) {
      const receiptLock = await acquireLock(key);
      receiptLocks.push(receiptLock);
      const stored = await readStored(key);
      await removeRecoveryCandidates(stored?.recovery_scope, [key]);
    }
    await removeLedgerEntries(keys);
    await fs.unlink(filePath).catch(() => undefined);
  } finally {
    for (const receiptLock of receiptLocks.toReversed()) {
      await releaseLock(receiptLock);
    }
  }
}

async function removeStaleLock(filePath: string): Promise<boolean> {
  try {
    const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as {
      pid?: unknown;
      created_at?: unknown;
    };
    if (
      typeof payload.pid === "number" &&
      (payload.pid === process.pid || isProcessAlive(payload.pid))
    ) {
      return false;
    }
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function acquireLockAt(filePath: string): Promise<MutationLock> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.mkdir(baseDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(baseDir(), 0o700);
  for (;;) {
    try {
      await fs.writeFile(
        filePath,
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      return { filePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (await removeStaleLock(filePath)) {
        continue;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function acquireLock(idempotencyKey: string): Promise<MutationLock> {
  return await acquireLockAt(lockPath(idempotencyKey));
}

async function releaseLock(lock: MutationLock): Promise<void> {
  await fs.unlink(lock.filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

function matches(stored: StoredMutation, operation: AcpxMutationOperation, hash: string): boolean {
  return stored.operation === operation && stored.fingerprint === hash;
}

function errorShape(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

// oxlint-disable-next-line eslint/complexity -- Durable record validation intentionally checks every scoped recovery discriminator.
function isRecoverableScopeMatch(
  value: unknown,
  operation: AcpxMutationOperation,
  scopeHash: string,
  currentKey: string,
): value is StoredMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schema === IDEMPOTENCY_SCHEMA &&
    record.operation === operation &&
    record.state === "started" &&
    record.recovery_scope === scopeHash &&
    typeof record.idempotency_key === "string" &&
    record.idempotency_key !== currentKey &&
    record.recovery_result !== undefined
  );
}

// oxlint-disable-next-line eslint/complexity -- Indexed recovery must fail closed for missing, corrupt, conflicting, and incomplete checkpoints.
async function findScopedRecoveries(
  operation: AcpxMutationOperation,
  scopeHash: string,
  currentKey: string,
  expectedCheckpoint?: unknown,
): Promise<StoredMutation[]> {
  const index = await readStringIndex(
    recoveryIndexPath(scopeHash),
    (value): value is RecoveryIndex => isRecoveryIndex(value, operation, scopeHash),
  );
  const candidates: StoredMutation[] = [];
  for (const key of index?.keys ?? []) {
    if (key === currentKey) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(mutationPath(key), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // The recovery index is written before the checkpoint receipt so a
        // crash cannot leave an unindexed provider side effect. A missing
        // indexed receipt is therefore ambiguous and must fail closed.
        throw new AcpxIdempotencyInDoubtError(currentKey, operation);
      }
      throw error;
    }
    if (isRecoverableScopeMatch(value, operation, scopeHash, currentKey)) {
      candidates.push(value);
    } else if ((value as StoredMutation | undefined)?.state === "started") {
      throw new AcpxIdempotencyInDoubtError(currentKey, operation);
    }
  }
  if (candidates.length === 0) {
    return [];
  }
  const checkpoint = JSON.stringify(
    canonicalize(expectedCheckpoint ?? candidates[0]?.recovery_result),
  );
  if (
    candidates.some(
      (candidate) => JSON.stringify(canonicalize(candidate.recovery_result)) !== checkpoint,
    )
  ) {
    throw new AcpxIdempotencyInDoubtError(currentKey, operation);
  }
  return candidates.toSorted((left, right) => right.updated_at.localeCompare(left.updated_at));
}

async function completeRecovery<T>(
  operation: AcpxMutationOperation,
  idempotencyKey: string,
  recover: (checkpoint: unknown) => Promise<T>,
  stored: StoredMutation,
): Promise<AcpxMutationReceipt<T>> {
  const result = await recover(stored.recovery_result);
  const updatedAt = new Date().toISOString();
  await bindStoredMutationToSession(stored, idempotencyKey, result);
  await writeStored(idempotencyKey, {
    ...stored,
    idempotency_key: idempotencyKey,
    state: "succeeded",
    updated_at: updatedAt,
    result,
  });
  await updateLedgerEntry(idempotencyKey, "succeeded", updatedAt);
  await removeRecoveryCandidates(stored.recovery_scope, [idempotencyKey]);
  return {
    operation,
    idempotencyKey,
    replayed: true,
    result,
  };
}

async function retireScopedRecoveries(
  candidates: StoredMutation[],
  result: unknown,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  for (const candidate of candidates) {
    await bindStoredMutationToSession(candidate, candidate.idempotency_key, result);
    await writeStored(candidate.idempotency_key, {
      ...candidate,
      state: "succeeded",
      updated_at: updatedAt,
      result,
    });
    await updateLedgerEntry(candidate.idempotency_key, "succeeded", updatedAt);
  }
  await removeRecoveryCandidates(
    candidates[0]?.recovery_scope,
    candidates.map((candidate) => candidate.idempotency_key),
  );
}

// oxlint-disable-next-line eslint/complexity -- Durable replay, recovery, ambiguity, and failure are separate terminal states.
export async function runIdempotentMutation<T>(options: {
  operation: AcpxMutationOperation;
  idempotencyKey: string;
  input: unknown;
  recoveryResult?: T;
  /** Groups incomplete side effects that may be reconciled by a retry using a fresh key. */
  recoveryScope?: unknown;
  recover?: (checkpoint: unknown) => Promise<T>;
  outcomeUnknown?: (error: unknown) => boolean;
  run: (checkpoint: (value: unknown) => Promise<void>) => Promise<T>;
}): Promise<AcpxMutationReceipt<T>> {
  assertIdempotencyKey(options.idempotencyKey);
  await migrateLegacyReceiptsIfNeeded();
  const scopeHash =
    options.recoveryScope === undefined ? undefined : fingerprint(options.recoveryScope);
  const recoveryLock = scopeHash ? await acquireLockAt(recoveryLockPath(scopeHash)) : undefined;
  let lock: MutationLock;
  try {
    lock = await acquireLock(options.idempotencyKey);
  } catch (error) {
    if (recoveryLock) {
      await releaseLock(recoveryLock);
    }
    throw error;
  }
  try {
    const inputHash = fingerprint(options.input);
    const stored = await readStored(options.idempotencyKey);
    if (stored) {
      if (!matches(stored, options.operation, inputHash)) {
        throw new AcpxIdempotencyConflictError(options.idempotencyKey);
      }
      if (stored.state === "succeeded") {
        return {
          operation: options.operation,
          idempotencyKey: options.idempotencyKey,
          replayed: true,
          result: stored.result as T,
        };
      }
      if (stored.state === "pruned") {
        throw new AcpxIdempotencySessionPrunedError(
          options.idempotencyKey,
          stored.acpx_record_id ?? "unknown",
        );
      }
      if (stored.state === "failed" && stored.error) {
        throw new AcpxIdempotentMutationError(
          options.idempotencyKey,
          options.operation,
          stored.error,
        );
      }
      if (stored.recovery_result !== undefined) {
        if (options.recover) {
          const equivalents = scopeHash
            ? await findScopedRecoveries(
                options.operation,
                scopeHash,
                options.idempotencyKey,
                stored.recovery_result,
              )
            : [];
          const receipt = await completeRecovery(
            options.operation,
            options.idempotencyKey,
            options.recover,
            stored,
          );
          await retireScopedRecoveries(equivalents, receipt.result);
          return receipt;
        }
        return {
          operation: options.operation,
          idempotencyKey: options.idempotencyKey,
          replayed: true,
          result: stored.recovery_result as T,
        };
      }
      throw new AcpxIdempotencyInDoubtError(options.idempotencyKey, options.operation);
    }
    await assertKeyNotRetired(options.idempotencyKey);

    const now = new Date().toISOString();
    const priors =
      scopeHash && options.recover
        ? await findScopedRecoveries(options.operation, scopeHash, options.idempotencyKey)
        : [];
    const prior = priors[0];
    const started: StoredMutation = {
      schema: IDEMPOTENCY_SCHEMA,
      idempotency_key: options.idempotencyKey,
      operation: options.operation,
      fingerprint: inputHash,
      state: "started",
      created_at: now,
      updated_at: now,
      pid: process.pid,
      recovery_scope: scopeHash,
      recovery_result: prior?.recovery_result ?? options.recoveryResult,
      acpx_record_id: extractAcpxRecordId(options.input),
    };
    if (started.acpx_record_id) {
      await addSessionReceipt(started.acpx_record_id, options.idempotencyKey);
    }
    await writeStored(options.idempotencyKey, started);
    try {
      await updateLedgerEntry(options.idempotencyKey, "started", now);
    } catch (error) {
      await fs.unlink(mutationPath(options.idempotencyKey)).catch(() => undefined);
      if (started.acpx_record_id) {
        await removeSessionReceipt(started.acpx_record_id, options.idempotencyKey);
      }
      throw error;
    }
    if (scopeHash && started.recovery_result !== undefined) {
      await addRecoveryCandidate(options.operation, scopeHash, options.idempotencyKey);
    }

    if (prior && options.recover) {
      try {
        const receipt = await completeRecovery(
          options.operation,
          options.idempotencyKey,
          options.recover,
          started,
        );
        await retireScopedRecoveries(priors, receipt.result);
        return receipt;
      } catch (error) {
        const updatedAt = new Date().toISOString();
        await writeStored(options.idempotencyKey, {
          ...started,
          updated_at: updatedAt,
          error: errorShape(error),
        });
        await updateLedgerEntry(options.idempotencyKey, "started", updatedAt);
        throw error;
      }
    }

    try {
      const checkpoint = async (value: unknown): Promise<void> => {
        if (scopeHash) {
          await addRecoveryCandidate(options.operation, scopeHash, options.idempotencyKey);
        }
        started.recovery_result = value;
        started.updated_at = new Date().toISOString();
        await writeStored(options.idempotencyKey, started);
        await bindStoredMutationToSession(started, options.idempotencyKey, value);
      };
      const result = await options.run(checkpoint);
      await bindStoredMutationToSession(started, options.idempotencyKey, result);
      const updatedAt = new Date().toISOString();
      await writeStored(options.idempotencyKey, {
        ...started,
        state: "succeeded",
        updated_at: updatedAt,
        result,
      });
      await updateLedgerEntry(options.idempotencyKey, "succeeded", updatedAt);
      await removeRecoveryCandidates(scopeHash, [options.idempotencyKey]);
      return {
        operation: options.operation,
        idempotencyKey: options.idempotencyKey,
        replayed: false,
        result,
      };
    } catch (error) {
      if (
        (started.recovery_result !== undefined && options.recover !== undefined) ||
        options.outcomeUnknown?.(error) === true
      ) {
        const updatedAt = new Date().toISOString();
        await writeStored(options.idempotencyKey, {
          ...started,
          updated_at: updatedAt,
          error: errorShape(error),
        });
        await updateLedgerEntry(options.idempotencyKey, "started", updatedAt);
        throw error;
      }
      const updatedAt = new Date().toISOString();
      await writeStored(options.idempotencyKey, {
        ...started,
        state: "failed",
        updated_at: updatedAt,
        error: errorShape(error),
      });
      await updateLedgerEntry(options.idempotencyKey, "failed", updatedAt);
      await removeRecoveryCandidates(scopeHash, [options.idempotencyKey]);
      throw error;
    }
  } finally {
    try {
      await releaseLock(lock);
    } finally {
      if (recoveryLock) {
        await releaseLock(recoveryLock);
      }
    }
  }
}

export const idempotencyTestInternals = {
  baseDir,
  canonicalize,
  fingerprint,
  ledgerIndexPath,
  lockPath,
  migrationMarkerPath,
  recoveryIndexPath,
  recoveryLockPath,
  retiredKeyHash,
  retiredKeysPath,
  sessionIndexPath,
  mutationPath,
  removeStaleLock,
};
