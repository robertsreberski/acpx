import { randomInt } from "node:crypto";
import fs from "node:fs/promises";
import { isProcessAlive } from "../../process-liveness.js";
import { getAcpxVersion } from "../../version.js";
import { queueBaseDir, queueLockFilePath, queueSocketBaseDir, queueSocketPath } from "./paths.js";

export { isProcessAlive } from "../../process-liveness.js";

// Budget for graceful SIGTERM shutdown of a queue-owner process.
// The owner runs AcpClient.close() during shutdown:
//   stdin-close grace (100 ms) + SIGTERM wait (1 500 ms) + SIGKILL wait (1 000 ms) = 2 600 ms worst case.
// We add ~1 400 ms of headroom for event-loop latency and process startup overhead → 4 000 ms.
// If the owner does not exit within this window we escalate to SIGKILL.
const PROCESS_SIGTERM_GRACE_MS = 4_000;
// After SIGKILL the OS terminates the process almost immediately; 1 500 ms is generous.
const PROCESS_SIGKILL_GRACE_MS = 1_500;
const PROCESS_POLL_MS = 50;
const QUEUE_OWNER_STALE_HEARTBEAT_MS = 15_000;

/**
 * Version of the queue owner IPC contract this build speaks.
 *
 * A queue owner is a long-lived process that outlives the CLI invocation that
 * spawned it, so an upgrade leaves an owner from the previous build serving
 * requests from the new one. Bump this whenever the two builds could disagree
 * about what a message *means*, as opposed to merely failing to parse it —
 * a parse failure is loud, a semantic disagreement is silent.
 *
 * 1: implicit for owners written before this field existed.
 * 2: permission policies carry `defer` rules and permission_escalation events
 *    carry action "defer". A v1 owner drops unknown rule lists, so a request
 *    the user asked to park is instead settled by the permission mode.
 * 3: cancel requests may name the exact turn they target. Older owners would
 *    ignore that field and could cancel a newer turn after a handoff race.
 * 4: exact cancellation targets both active and queued turns. A v3 owner only
 *    checks the active turn and would silently leave a queued target in place.
 * 5: clients can read the exact queued prompt FIFO from its owning generation.
 */
export const QUEUE_PROTOCOL_VERSION = 5;
/** Owners whose lease predates the queueProtocol field. */
export const LEGACY_QUEUE_PROTOCOL_VERSION = 1;
/** First protocol version that understands `defer` permission policies. */
export const QUEUE_PROTOCOL_DEFER_VERSION = 2;
/** First protocol version that atomically cancels an exact active or queued turn. */
export const QUEUE_PROTOCOL_EXACT_CANCEL_VERSION = 4;
/** First protocol version that exposes the exact prompt FIFO read-only. */
export const QUEUE_PROTOCOL_PROMPT_QUEUE_SNAPSHOT_VERSION = 5;

/**
 * Number of permission-policy rule keys this protocol version was decided
 * against. Adding a key to PERMISSION_POLICY_RULE_KEYS means every existing
 * owner silently ignores it — the same failure `defer` had — so a new rule key
 * is a protocol decision, not a local one. When one lands: teach
 * `permissionPolicyNeedsDeferSupport` (src/cli/queue/ipc.ts) about the new key,
 * bump QUEUE_PROTOCOL_VERSION, then update this count. A test pins the two
 * together so the decision cannot be skipped by accident.
 */
export const QUEUE_PROTOCOL_RULE_KEY_COUNT = 4;

// Known and deliberately unmitigated: a client from a build that predates
// protocol v2 talking to a current owner still fails with
// QUEUE_PROTOCOL_MALFORMED_MESSAGE when it receives action "defer", because old
// clients do not read `queueProtocol`.
//
// This is fixable — the submit request could carry a `clientProtocol` field and
// the owner could downgrade "defer" to "escalate" for old clients. We are not
// doing it: that direction fails loud rather than silently mis-deciding a
// permission, it only occurs when someone runs an older client against a newer
// warm owner (a downgrade, not the normal upgrade path), and the downgrade
// would make an owner report an action it did not take. Do not re-open this on
// the premise that it is unfixable; it is a cost/benefit call.

export type QueueOwnerRecord = {
  pid: number;
  sessionId: string;
  socketPath: string;
  createdAt: string;
  heartbeatAt: string;
  ownerGeneration: number;
  queueDepth: number;
  mcpConfigPath?: string;
  mcpConfigFingerprint?: string;
  queueProtocol?: number;
  acpxVersion?: string;
  /** Owner was started with --defer and can park deferred requests. */
  parking?: boolean;
  /** The owner's effective --defer-max-age, in ms. Owner-level, like parking. */
  parkingMaxAgeMs?: number;
  /** This owner writes the authoritative session timeline alongside compatibility streams. */
  timeline?: boolean;
};

export type QueueOwnerLease = {
  sessionId: string;
  lockPath: string;
  socketPath: string;
  createdAt: string;
  ownerGeneration: number;
  mcpConfigPath?: string;
  mcpConfigFingerprint?: string;
  parking?: boolean;
  parkingMaxAgeMs?: number;
  /** Every lease created by this build owns authoritative timeline writes. */
  timeline: true;
};

/** Protocol version an owner speaks, defaulting to the pre-field behavior. */
export function queueOwnerProtocolVersion(owner: QueueOwnerRecord): number {
  return owner.queueProtocol ?? LEGACY_QUEUE_PROTOCOL_VERSION;
}

/** Missing and explicit false both identify a pre-timeline owner. */
export function queueOwnerWritesTimeline(owner: QueueOwnerRecord): boolean {
  return owner.timeline === true;
}

export type QueueOwnerStatus = {
  pid: number;
  socketPath: string;
  heartbeatAt: string;
  ownerGeneration: number;
  queueDepth: number;
  alive: boolean;
  stale: boolean;
};

function parseQueueOwnerRecord(raw: unknown): QueueOwnerRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;

  if (!hasValidQueueOwnerRecordFields(record)) {
    return null;
  }

  return {
    pid: record.pid,
    sessionId: record.sessionId,
    socketPath: record.socketPath,
    createdAt: record.createdAt,
    heartbeatAt: record.heartbeatAt,
    ownerGeneration: record.ownerGeneration,
    queueDepth: record.queueDepth,
    ...parseQueueOwnerRecordMetadata(record),
  };
}

/** Optional lease metadata; absent fields simply stay off the record. */
function parseQueueOwnerRecordMetadata(
  record: Record<string, unknown>,
): Pick<
  QueueOwnerRecord,
  | "mcpConfigPath"
  | "mcpConfigFingerprint"
  | "queueProtocol"
  | "acpxVersion"
  | "parking"
  | "parkingMaxAgeMs"
  | "timeline"
> {
  return {
    ...(typeof record.mcpConfigPath === "string" ? { mcpConfigPath: record.mcpConfigPath } : {}),
    ...(typeof record.mcpConfigFingerprint === "string"
      ? { mcpConfigFingerprint: record.mcpConfigFingerprint }
      : {}),
    ...(isPositiveInteger(record.queueProtocol) ? { queueProtocol: record.queueProtocol } : {}),
    ...(typeof record.acpxVersion === "string" ? { acpxVersion: record.acpxVersion } : {}),
    ...(record.parking === true ? { parking: true } : {}),
    ...(typeof record.parkingMaxAgeMs === "number" && Number.isFinite(record.parkingMaxAgeMs)
      ? { parkingMaxAgeMs: record.parkingMaxAgeMs }
      : {}),
    ...parseTimelineCapability(record.timeline),
  };
}

function parseTimelineCapability(value: unknown): Pick<QueueOwnerRecord, "timeline"> {
  return typeof value === "boolean" ? { timeline: value } : {};
}

function currentQueueOwnerBuildMetadata(): Pick<
  QueueOwnerRecord,
  "queueProtocol" | "acpxVersion" | "timeline"
> & { timeline: true } {
  return {
    queueProtocol: QUEUE_PROTOCOL_VERSION,
    acpxVersion: getAcpxVersion(),
    timeline: true,
  };
}

function hasValidQueueOwnerRecordFields(record: Record<string, unknown>): record is Record<
  string,
  unknown
> & {
  pid: number;
  sessionId: string;
  socketPath: string;
  createdAt: string;
  heartbeatAt: string;
  ownerGeneration: number;
  queueDepth: number;
} {
  return (
    isPositiveInteger(record.pid) &&
    typeof record.sessionId === "string" &&
    typeof record.socketPath === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.heartbeatAt === "string" &&
    isPositiveInteger(record.ownerGeneration) &&
    isNonNegativeInteger(record.queueDepth)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function createOwnerGeneration(): number {
  return randomInt(1, 2 ** 48);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A heartbeat older than the window means the owner's event loop has not run
 * recently: suspended, wedged, or gone. It is not proof of death — only a
 * caller taking the session over may act on it — but it is the cheapest honest
 * signal that the owner is not currently answering.
 */
export function isQueueOwnerHeartbeatStale(owner: QueueOwnerRecord): boolean {
  const heartbeatMs = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) {
    return true;
  }
  return Date.now() - heartbeatMs > QUEUE_OWNER_STALE_HEARTBEAT_MS;
}

async function ensureQueueDir(): Promise<void> {
  const baseDir = queueBaseDir();
  try {
    await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
    await fs.chmod(baseDir, 0o700);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare queue directory ${baseDir}: ${message}`, {
      cause: error,
    });
  }
  const socketDir = queueSocketBaseDir();
  if (socketDir) {
    try {
      await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
      await fs.chmod(socketDir, 0o700);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to prepare queue socket directory ${socketDir}: ${message}`, {
        cause: error,
      });
    }
  }
}

async function removeSocketFile(socketPath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  try {
    await fs.unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await waitMs(PROCESS_POLL_MS);
  }

  return !isProcessAlive(pid);
}

async function cleanupStaleQueueOwner(
  sessionId: string,
  owner: QueueOwnerRecord | undefined,
): Promise<void> {
  const lockPath = queueLockFilePath(sessionId);
  const socketPath = owner?.socketPath ?? queueSocketPath(sessionId);

  await removeSocketFile(socketPath).catch(() => {
    // ignore stale socket cleanup failures
  });

  await fs.unlink(lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

async function retireStaleQueueOwner(
  sessionId: string,
  owner: QueueOwnerRecord | undefined,
): Promise<void> {
  if (owner && isProcessAlive(owner.pid)) {
    await terminateProcess(owner.pid);
  }

  await cleanupStaleQueueOwner(sessionId, owner);
}

export async function readQueueOwnerRecord(
  sessionId: string,
): Promise<QueueOwnerRecord | undefined> {
  const lockPath = queueLockFilePath(sessionId);
  try {
    const payload = await fs.readFile(lockPath, "utf8");
    const parsed = parseQueueOwnerRecord(JSON.parse(payload));
    return parsed ?? undefined;
  } catch {
    return undefined;
  }
}

export async function terminateProcess(pid: number): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }

  if (await waitForProcessExit(pid, PROCESS_SIGTERM_GRACE_MS)) {
    return true;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return false;
  }

  await waitForProcessExit(pid, PROCESS_SIGKILL_GRACE_MS);
  return true;
}

export async function ensureOwnerIsUsable(
  sessionId: string,
  owner: QueueOwnerRecord,
): Promise<boolean> {
  const alive = isProcessAlive(owner.pid);
  const stale = isQueueOwnerHeartbeatStale(owner);
  if (alive && !stale) {
    return true;
  }

  await retireStaleQueueOwner(sessionId, owner);
  return false;
}

/**
 * The recorded owner for a session, if its process is still alive.
 *
 * Non-mutating counterpart to `readQueueOwnerStatus`: it never retires, kills,
 * or cleans anything up, so a read-only caller cannot destroy a live owner as a
 * side effect of looking at it.
 *
 * Heartbeat staleness is deliberately not considered. A stale heartbeat is a
 * symptom — a suspended process, a laptop that slept, an event loop under load
 * — not proof of death, and inspection paths must not act on a symptom. Only
 * paths that are about to take the session over (acquiring the lease, or
 * submitting work) may escalate a stale heartbeat into retirement.
 */
export async function readLiveQueueOwner(sessionId: string): Promise<QueueOwnerRecord | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  return owner && isProcessAlive(owner.pid) ? owner : undefined;
}

export async function readQueueOwnerStatus(
  sessionId: string,
): Promise<QueueOwnerStatus | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return undefined;
  }

  const alive = await ensureOwnerIsUsable(sessionId, owner);
  if (!alive) {
    return undefined;
  }

  return {
    pid: owner.pid,
    socketPath: owner.socketPath,
    heartbeatAt: owner.heartbeatAt,
    ownerGeneration: owner.ownerGeneration,
    queueDepth: owner.queueDepth,
    alive,
    stale: isQueueOwnerHeartbeatStale(owner),
  };
}

export async function tryAcquireQueueOwnerLease(
  sessionId: string,
  mcpConfigOrNowIsoFactory?:
    | string
    | {
        path?: string;
        fingerprint?: string;
        parking?: boolean;
        parkingMaxAgeMs?: number;
      }
    | (() => string),
  nowIsoFactory: () => string = nowIso,
): Promise<QueueOwnerLease | undefined> {
  const { mcpConfigPath, clock } = resolveLeaseArguments(mcpConfigOrNowIsoFactory, nowIsoFactory);
  const { parking, parkingMaxAgeMs } = readParkingMetadata(mcpConfigOrNowIsoFactory);
  const mcpConfigFingerprint = readMcpConfigFingerprint(mcpConfigOrNowIsoFactory);
  const mcpConfigMetadata = createMcpConfigMetadata(mcpConfigPath, mcpConfigFingerprint);
  await ensureQueueDir();
  const lockPath = queueLockFilePath(sessionId);
  const socketPath = queueSocketPath(sessionId);
  const createdAt = clock();
  const ownerGeneration = createOwnerGeneration();
  const payload = JSON.stringify(
    {
      pid: process.pid,
      sessionId,
      socketPath,
      createdAt,
      heartbeatAt: createdAt,
      ownerGeneration,
      queueDepth: 0,
      ...currentQueueOwnerBuildMetadata(),
      ...(parking ? { parking: true } : {}),
      ...(parkingMaxAgeMs === undefined ? {} : { parkingMaxAgeMs }),
      ...mcpConfigMetadata,
    },
    null,
    2,
  );

  try {
    await fs.writeFile(lockPath, `${payload}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await removeSocketFile(socketPath).catch(() => {
      // best-effort stale socket cleanup after ownership is acquired
    });
    return {
      sessionId,
      lockPath,
      socketPath,
      createdAt,
      ownerGeneration,
      timeline: true,
      ...(parking ? { parking: true } : {}),
      ...(parkingMaxAgeMs === undefined ? {} : { parkingMaxAgeMs }),
      ...mcpConfigMetadata,
    };
  } catch (error) {
    return await handleLeaseCollision(sessionId, error);
  }
}

function readParkingMetadata(value: unknown): {
  parking: boolean;
  parkingMaxAgeMs?: number;
} {
  if (!value || typeof value !== "object") {
    return { parking: false };
  }
  const record = value as { parking?: boolean; parkingMaxAgeMs?: number };
  return {
    parking: record.parking === true,
    ...(record.parkingMaxAgeMs === undefined ? {} : { parkingMaxAgeMs: record.parkingMaxAgeMs }),
  };
}

function readMcpConfigFingerprint(
  mcpConfigOrNowIsoFactory:
    | string
    | {
        path?: string;
        fingerprint?: string;
      }
    | (() => string)
    | undefined,
): string | undefined {
  return typeof mcpConfigOrNowIsoFactory === "object"
    ? mcpConfigOrNowIsoFactory?.fingerprint
    : undefined;
}

function createMcpConfigMetadata(
  mcpConfigPath: string | undefined,
  mcpConfigFingerprint: string | undefined,
): { mcpConfigPath?: string; mcpConfigFingerprint?: string } {
  return {
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
    ...(mcpConfigFingerprint ? { mcpConfigFingerprint } : {}),
  };
}

async function handleLeaseCollision(sessionId: string, error: unknown): Promise<undefined> {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
    throw error;
  }

  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    await cleanupStaleQueueOwner(sessionId, owner);
    return undefined;
  }

  if (!isProcessAlive(owner.pid) || isQueueOwnerHeartbeatStale(owner)) {
    await retireStaleQueueOwner(sessionId, owner);
  }
  return undefined;
}

function resolveLeaseArguments(
  mcpConfigOrNowIsoFactory:
    | string
    | {
        path?: string;
        fingerprint?: string;
      }
    | (() => string)
    | undefined,
  nowIsoFactory: () => string,
): { mcpConfigPath: string | undefined; clock: () => string } {
  if (typeof mcpConfigOrNowIsoFactory === "string") {
    return { mcpConfigPath: mcpConfigOrNowIsoFactory, clock: nowIsoFactory };
  }
  if (typeof mcpConfigOrNowIsoFactory === "function") {
    return { mcpConfigPath: undefined, clock: mcpConfigOrNowIsoFactory };
  }
  if (mcpConfigOrNowIsoFactory) {
    return { mcpConfigPath: mcpConfigOrNowIsoFactory.path, clock: nowIsoFactory };
  }
  return { mcpConfigPath: undefined, clock: nowIsoFactory };
}

export async function refreshQueueOwnerLease(
  lease: QueueOwnerLease,
  options: {
    queueDepth: number;
  },
  nowIsoFactory: () => string = nowIso,
): Promise<void> {
  const payload = JSON.stringify(
    {
      pid: process.pid,
      sessionId: lease.sessionId,
      socketPath: lease.socketPath,
      createdAt: lease.createdAt,
      heartbeatAt: nowIsoFactory(),
      ownerGeneration: lease.ownerGeneration,
      queueDepth: Math.max(0, Math.round(options.queueDepth)),
      ...currentQueueOwnerBuildMetadata(),
      ...(lease.parking ? { parking: true } : {}),
      ...(lease.parkingMaxAgeMs === undefined ? {} : { parkingMaxAgeMs: lease.parkingMaxAgeMs }),
      ...(lease.mcpConfigPath ? { mcpConfigPath: lease.mcpConfigPath } : {}),
      ...(lease.mcpConfigFingerprint ? { mcpConfigFingerprint: lease.mcpConfigFingerprint } : {}),
    },
    null,
    2,
  );
  await fs.writeFile(lease.lockPath, `${payload}\n`, {
    encoding: "utf8",
  });
}

export async function releaseQueueOwnerLease(lease: QueueOwnerLease): Promise<void> {
  await removeSocketFile(lease.socketPath).catch(() => {
    // ignore best-effort cleanup failures
  });

  await fs.unlink(lease.lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

export async function terminateQueueOwnerForSession(sessionId: string): Promise<void> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return;
  }

  if (isProcessAlive(owner.pid)) {
    await terminateProcess(owner.pid);
  }

  await cleanupStaleQueueOwner(sessionId, owner);
}

export async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
