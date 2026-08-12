import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isProcessAlive } from "../process-liveness.js";
import type { AcpxMutationOperation, AcpxMutationReceipt } from "./contract.js";

const IDEMPOTENCY_SCHEMA = "acpx.session_mutation.v1" as const;
const LOCK_RETRY_MS = 20;
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
  state: "started" | "succeeded" | "failed";
  created_at: string;
  updated_at: string;
  pid: number;
  recovery_scope?: string;
  recovery_result?: unknown;
  result?: unknown;
  error?: { name: string; message: string };
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
      (record.recovery_scope !== undefined && typeof record.recovery_scope !== "string") ||
      (record.state !== "started" && record.state !== "succeeded" && record.state !== "failed")
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

async function writeStored(idempotencyKey: string, value: StoredMutation): Promise<void> {
  await fs.mkdir(baseDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(baseDir(), 0o700);
  const filePath = mutationPath(idempotencyKey);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
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

// oxlint-disable-next-line eslint/complexity -- Directory scanning distinguishes I/O failure, foreign corruption, and conflicting checkpoints.
async function findScopedRecovery(
  operation: AcpxMutationOperation,
  scopeHash: string,
  currentKey: string,
): Promise<StoredMutation | undefined> {
  let files: string[];
  try {
    files = await fs.readdir(baseDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const candidates: StoredMutation[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(path.join(baseDir(), file), "utf8")) as unknown;
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      // A corrupt record for another idempotency key must not disable recovery
      // for this scope. Direct use of that key still fails closed in readStored.
      continue;
    }
    if (isRecoverableScopeMatch(value, operation, scopeHash, currentKey)) {
      candidates.push(value);
    }
  }
  if (candidates.length === 0) {
    return undefined;
  }
  const checkpoint = JSON.stringify(canonicalize(candidates[0]?.recovery_result));
  if (
    candidates.some(
      (candidate) => JSON.stringify(canonicalize(candidate.recovery_result)) !== checkpoint,
    )
  ) {
    throw new AcpxIdempotencyInDoubtError(currentKey, operation);
  }
  return candidates.toSorted((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
}

async function completeRecovery<T>(
  operation: AcpxMutationOperation,
  idempotencyKey: string,
  recover: (checkpoint: unknown) => Promise<T>,
  stored: StoredMutation,
): Promise<AcpxMutationReceipt<T>> {
  const result = await recover(stored.recovery_result);
  await writeStored(idempotencyKey, {
    ...stored,
    idempotency_key: idempotencyKey,
    state: "succeeded",
    updated_at: new Date().toISOString(),
    result,
  });
  return {
    operation,
    idempotencyKey,
    replayed: true,
    result,
  };
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
      if (stored.state === "failed" && stored.error) {
        throw new AcpxIdempotentMutationError(
          options.idempotencyKey,
          options.operation,
          stored.error,
        );
      }
      if (stored.recovery_result !== undefined) {
        if (options.recover) {
          return await completeRecovery(
            options.operation,
            options.idempotencyKey,
            options.recover,
            stored,
          );
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

    const now = new Date().toISOString();
    const prior =
      scopeHash && options.recover
        ? await findScopedRecovery(options.operation, scopeHash, options.idempotencyKey)
        : undefined;
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
    };
    await writeStored(options.idempotencyKey, started);

    if (prior && options.recover) {
      try {
        const receipt = await completeRecovery(
          options.operation,
          options.idempotencyKey,
          options.recover,
          started,
        );
        await writeStored(prior.idempotency_key, {
          ...prior,
          state: "succeeded",
          updated_at: new Date().toISOString(),
          result: receipt.result,
        });
        return receipt;
      } catch (error) {
        await writeStored(options.idempotencyKey, {
          ...started,
          updated_at: new Date().toISOString(),
          error: errorShape(error),
        });
        throw error;
      }
    }

    try {
      const checkpoint = async (value: unknown): Promise<void> => {
        started.recovery_result = value;
        started.updated_at = new Date().toISOString();
        await writeStored(options.idempotencyKey, started);
      };
      const result = await options.run(checkpoint);
      await writeStored(options.idempotencyKey, {
        ...started,
        state: "succeeded",
        updated_at: new Date().toISOString(),
        result,
      });
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
        await writeStored(options.idempotencyKey, {
          ...started,
          updated_at: new Date().toISOString(),
          error: errorShape(error),
        });
        throw error;
      }
      await writeStored(options.idempotencyKey, {
        ...started,
        state: "failed",
        updated_at: new Date().toISOString(),
        error: errorShape(error),
      });
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
  lockPath,
  recoveryLockPath,
  mutationPath,
  removeStaleLock,
};
