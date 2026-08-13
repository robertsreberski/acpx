import { randomInt, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { isProcessAlive } from "../../process-liveness.js";
import { createAtomicWriteTempPath } from "../../session/persistence/atomic-write.js";
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
const QUEUE_OWNER_RETIREMENT_WAIT_MS = 7_000;
const QUEUE_OWNER_RETIREMENT_POLL_MS = 25;
const QUEUE_OWNER_RETIREMENT_LIVENESS_TIMEOUT_MS = 250;

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
 * 3: prompt session options carry `effort`, and clients may send the
 *    `apply_session_preferences` control request. A v2 owner silently drops
 *    effort from prompt options and cannot apply the combined control.
 * 4: every submit_prompt result carries a discriminated completion status,
 *    including context-compaction incompleteness. A v1/v2/v3 owner can accept
 *    the request but cannot report that outcome safely.
 */
export const QUEUE_PROTOCOL_VERSION = 4;
/** Owners whose lease predates the queueProtocol field. */
export const LEGACY_QUEUE_PROTOCOL_VERSION = 1;
/** First protocol version that understands `defer` permission policies. */
export const QUEUE_PROTOCOL_DEFER_VERSION = 2;
/** First protocol version that understands effort-bearing requests. */
export const QUEUE_PROTOCOL_EFFORT_VERSION = 3;
/** First protocol version with discriminated prompt completion results. */
export const QUEUE_PROTOCOL_COMPLETION_STATUS_VERSION = 4;

/**
 * Number of permission-policy rule keys this protocol version was decided
 * against. Adding a key to PERMISSION_POLICY_RULE_KEYS means every existing
 * owner silently ignores it — the same failure `defer` had — so a new rule key
 * is a protocol decision, not a local one. When one lands, bump
 * QUEUE_PROTOCOL_VERSION, add any required submission compatibility gate,
 * then update this count. A test pins the two together so the decision cannot
 * be skipped by accident.
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
};

type QueueOwnerLeaseMutationState = {
  pending: Promise<void>;
  releasePromise: Promise<void> | undefined;
  releasing: boolean;
};

const queueOwnerLeaseMutationStates = new WeakMap<QueueOwnerLease, QueueOwnerLeaseMutationState>();

function queueOwnerLeaseMutationState(lease: QueueOwnerLease): QueueOwnerLeaseMutationState {
  const existing = queueOwnerLeaseMutationStates.get(lease);
  if (existing) {
    return existing;
  }
  const created: QueueOwnerLeaseMutationState = {
    pending: Promise.resolve(),
    releasePromise: undefined,
    releasing: false,
  };
  queueOwnerLeaseMutationStates.set(lease, created);
  return created;
}

function enqueueQueueOwnerLeaseMutation(
  state: QueueOwnerLeaseMutationState,
  mutation: () => Promise<void>,
): Promise<void> {
  const result = state.pending.then(mutation);
  state.pending = result.catch(() => undefined);
  return result;
}

/** Protocol version an owner speaks, defaulting to the pre-field behavior. */
export function queueOwnerProtocolVersion(owner: QueueOwnerRecord): number {
  return owner.queueProtocol ?? LEGACY_QUEUE_PROTOCOL_VERSION;
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
  if (owner) {
    const result = await terminateQueueOwnerIfCurrent(sessionId, owner);
    if (result === "failed") {
      throw new Error(`Failed to retire stale queue owner for session ${sessionId}`);
    }
    return;
  }

  await cleanupStaleQueueOwner(sessionId, owner);
}

type QueueOwnerRetirementMarker = {
  markerId: string;
  livenessPath: string;
  pid: number;
  ownerGeneration: number;
  createdAt: string;
};

function retirementMarkerPath(lockPath: string): string {
  return `${lockPath}.retiring`;
}

function parseRetirementMarker(
  raw: Record<string, unknown>,
): QueueOwnerRetirementMarker | undefined {
  if (
    typeof raw.markerId !== "string" ||
    raw.markerId.length === 0 ||
    typeof raw.livenessPath !== "string" ||
    raw.livenessPath.length === 0 ||
    !isPositiveInteger(raw.pid) ||
    !isPositiveInteger(raw.ownerGeneration) ||
    typeof raw.createdAt !== "string"
  ) {
    return undefined;
  }
  return {
    markerId: raw.markerId,
    livenessPath: raw.livenessPath,
    pid: raw.pid,
    ownerGeneration: raw.ownerGeneration,
    createdAt: raw.createdAt,
  };
}

async function readRetirementMarker(
  markerPath: string,
): Promise<QueueOwnerRetirementMarker | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(markerPath, "utf8")) as Record<string, unknown>;
    return parseRetirementMarker(raw);
  } catch {
    return undefined;
  }
}

async function retirementMarkerIsActive(marker: QueueOwnerRetirementMarker): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(marker.livenessPath);
    const timeout = setTimeout(() => {
      // A timeout is inconclusive. Preserve the marker and socket rather than
      // risk unlinking a live listener whose accept backlog is temporarily full.
      finish(true);
    }, QUEUE_OWNER_RETIREMENT_LIVENESS_TIMEOUT_MS);
    const finish = (active: boolean): void => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(active);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function retirementMarkerQuarantinePrefix(lockPath: string): string {
  return `${retirementMarkerPath(lockPath)}.quarantine.`;
}

async function listRetirementMarkerPaths(lockPath: string): Promise<string[]> {
  const markerPath = retirementMarkerPath(lockPath);
  const markerName = path.basename(markerPath);
  const quarantinePrefix = `${markerName}.quarantine.`;
  try {
    const entries = await fs.readdir(path.dirname(markerPath));
    return entries
      .filter((entry) => entry === markerName || entry.startsWith(quarantinePrefix))
      .map((entry) => path.join(path.dirname(markerPath), entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function createRetirementQuarantinePath(lockPath: string): string {
  return `${retirementMarkerQuarantinePrefix(lockPath)}${process.pid}.${randomUUID()}`;
}

async function restoreQuarantinedRetirementMarker(
  lockPath: string,
  quarantinePath: string,
): Promise<void> {
  try {
    await fs.link(quarantinePath, retirementMarkerPath(lockPath));
    await fs.unlink(quarantinePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOENT") {
      throw error;
    }
    // If another marker already owns the shared path, keep this uniquely named
    // quarantine visible until its marker owner releases it.
  }
}

async function inspectSharedRetirementMarker(
  lockPath: string,
): Promise<QueueOwnerRetirementMarker | undefined> {
  const markerPath = retirementMarkerPath(lockPath);
  const initial = await readRetirementMarker(markerPath);
  if (initial && (await retirementMarkerIsActive(initial))) {
    return initial;
  }

  const quarantinePath = createRetirementQuarantinePath(lockPath);
  try {
    await fs.rename(markerPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const quarantined = await readRetirementMarker(quarantinePath);
  if (quarantined && (await retirementMarkerIsActive(quarantined))) {
    await restoreQuarantinedRetirementMarker(lockPath, quarantinePath);
    return quarantined;
  }
  await removeInactiveRetirementLiveness(quarantined);
  await fs.unlink(quarantinePath).catch(() => undefined);
  return undefined;
}

async function inspectUniqueRetirementMarker(
  markerPath: string,
): Promise<QueueOwnerRetirementMarker | undefined> {
  const marker = await readRetirementMarker(markerPath);
  if (marker && (await retirementMarkerIsActive(marker))) {
    return marker;
  }
  await removeInactiveRetirementLiveness(marker);
  await fs.unlink(markerPath).catch(() => undefined);
  return undefined;
}

async function activeRetirementMarkers(lockPath: string): Promise<QueueOwnerRetirementMarker[]> {
  const sharedPath = retirementMarkerPath(lockPath);
  const markerPaths = await listRetirementMarkerPaths(lockPath);
  const markers = await Promise.all(
    markerPaths.map(async (markerPath) =>
      markerPath === sharedPath
        ? await inspectSharedRetirementMarker(lockPath)
        : await inspectUniqueRetirementMarker(markerPath),
    ),
  );
  const byMarkerId = new Map<string, QueueOwnerRetirementMarker>();
  for (const marker of markers) {
    if (marker) {
      byMarkerId.set(marker.markerId, marker);
    }
  }
  return [...byMarkerId.values()];
}

async function queueOwnerRetirementIsActive(lockPath: string): Promise<boolean> {
  return (await activeRetirementMarkers(lockPath)).length > 0;
}

async function waitForQueueOwnerRetirement(lockPath: string): Promise<void> {
  const deadline = Date.now() + QUEUE_OWNER_RETIREMENT_WAIT_MS;
  while (await queueOwnerRetirementIsActive(lockPath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for queue owner retirement lock ${lockPath}`);
    }
    await waitMs(QUEUE_OWNER_RETIREMENT_POLL_MS);
  }
}

type QueueOwnerRetirementMarkerLease = {
  marker: QueueOwnerRetirementMarker;
  livenessServer: net.Server;
};

function retirementMarkerLivenessPath(markerId: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\acpx-retire-${markerId}`
    : path.join("/tmp", `acpx-retire-${markerId}.sock`);
}

async function removeInactiveRetirementLiveness(
  marker: QueueOwnerRetirementMarker | undefined,
): Promise<void> {
  if (
    process.platform === "win32" ||
    !marker ||
    marker.livenessPath !== retirementMarkerLivenessPath(marker.markerId)
  ) {
    return;
  }
  await removeSocketFile(marker.livenessPath).catch(() => {
    // Best effort after kernel-backed liveness has already proved inactive.
  });
}

async function startRetirementMarkerLiveness(
  markerId: string,
): Promise<{ livenessPath: string; livenessServer: net.Server }> {
  const livenessPath = retirementMarkerLivenessPath(markerId);
  if (process.platform !== "win32") {
    await fs.unlink(livenessPath).catch(() => undefined);
  }
  const livenessServer = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    livenessServer.once("error", onError);
    livenessServer.listen(livenessPath, () => {
      livenessServer.off("error", onError);
      resolve();
    });
  });
  livenessServer.unref();
  return { livenessPath, livenessServer };
}

async function stopRetirementMarkerLiveness(lease: QueueOwnerRetirementMarkerLease): Promise<void> {
  if (lease.livenessServer.listening) {
    await new Promise<void>((resolve) => lease.livenessServer.close(() => resolve()));
  }
  if (process.platform !== "win32") {
    await fs.unlink(lease.marker.livenessPath).catch(() => undefined);
  }
}

async function tryCreateRetirementMarker(
  lockPath: string,
  expected: QueueOwnerRecord,
): Promise<QueueOwnerRetirementMarkerLease | undefined> {
  const markerPath = retirementMarkerPath(lockPath);
  const markerId = randomUUID();
  const temporaryPath = `${markerPath}.publish.${markerId}.tmp`;
  const liveness = await startRetirementMarkerLiveness(markerId);
  const marker: QueueOwnerRetirementMarker = {
    markerId,
    livenessPath: liveness.livenessPath,
    pid: process.pid,
    ownerGeneration: expected.ownerGeneration,
    createdAt: nowIso(),
  };
  const lease: QueueOwnerRetirementMarkerLease = {
    marker,
    livenessServer: liveness.livenessServer,
  };
  let keepLiveness = false;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.link(temporaryPath, markerPath);
    const competingMarker = (await activeRetirementMarkers(lockPath)).some(
      (active) => active.markerId !== marker.markerId,
    );
    if (competingMarker) {
      await removeOwnedRetirementMarkers(lockPath, marker.markerId);
      return undefined;
    }
    keepLiveness = true;
    return lease;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    return undefined;
  } finally {
    await fs.unlink(temporaryPath).catch(() => {
      // Best effort after publishing the completed marker through a hard link.
    });
    if (!keepLiveness) {
      await stopRetirementMarkerLiveness(lease);
    }
  }
}

async function removeSharedRetirementMarkerIfOwned(
  lockPath: string,
  markerId: string,
): Promise<void> {
  const markerPath = retirementMarkerPath(lockPath);
  const quarantinePath = createRetirementQuarantinePath(lockPath);
  try {
    await fs.rename(markerPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const marker = await readRetirementMarker(quarantinePath);
  if (marker?.markerId === markerId) {
    await fs.unlink(quarantinePath).catch(() => undefined);
    return;
  }
  await restoreQuarantinedRetirementMarker(lockPath, quarantinePath);
}

async function removeUniqueRetirementMarkerIfOwned(
  markerPath: string,
  markerId: string,
): Promise<void> {
  if ((await readRetirementMarker(markerPath))?.markerId === markerId) {
    await fs.unlink(markerPath).catch(() => undefined);
  }
}

async function removeOwnedRetirementMarkers(lockPath: string, markerId: string): Promise<void> {
  const sharedPath = retirementMarkerPath(lockPath);
  // A concurrent stale-marker cleanup may move the shared marker to a unique
  // quarantine between scans. Re-scan so the immutable marker identity is
  // removed without ever unlinking a path owned by another marker.
  for (let pass = 0; pass < 3; pass += 1) {
    const markerPaths = await listRetirementMarkerPaths(lockPath);
    await Promise.all(
      markerPaths.map(async (markerPath) =>
        markerPath === sharedPath
          ? await removeSharedRetirementMarkerIfOwned(lockPath, markerId)
          : await removeUniqueRetirementMarkerIfOwned(markerPath, markerId),
      ),
    );
  }
}

export async function readQueueOwnerRecord(
  sessionId: string,
): Promise<QueueOwnerRecord | undefined> {
  const state = await readQueueOwnerRecordState(sessionId);
  return state.kind === "record" ? state.owner : undefined;
}

type QueueOwnerRecordReadState =
  | { kind: "record"; owner: QueueOwnerRecord }
  | { kind: "missing" }
  | { kind: "unreadable" };

async function readQueueOwnerRecordStateAtPath(
  recordPath: string,
): Promise<QueueOwnerRecordReadState> {
  try {
    const payload = await fs.readFile(recordPath, "utf8");
    const parsed = parseQueueOwnerRecord(JSON.parse(payload));
    return parsed ? { kind: "record", owner: parsed } : { kind: "unreadable" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable" };
  }
}

async function readQueueOwnerRecordState(sessionId: string): Promise<QueueOwnerRecordReadState> {
  return await readQueueOwnerRecordStateAtPath(queueLockFilePath(sessionId));
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
  await waitForQueueOwnerRetirement(lockPath);
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
      queueProtocol: QUEUE_PROTOCOL_VERSION,
      acpxVersion: getAcpxVersion(),
      ...(parking ? { parking: true } : {}),
      ...(parkingMaxAgeMs === undefined ? {} : { parkingMaxAgeMs }),
      ...mcpConfigMetadata,
    },
    null,
    2,
  );

  const temporaryPath = createAtomicWriteTempPath(lockPath);
  await fs.writeFile(temporaryPath, `${payload}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    try {
      // Publish only a complete record. Writing directly with `wx` creates the
      // inode before its contents are visible, so a contender can misclassify
      // the in-progress owner record as stale and unlink the winning lease.
      await fs.link(temporaryPath, lockPath);
    } catch (error) {
      return await handleLeaseCollision(sessionId, error);
    }
    await removeSocketFile(socketPath).catch(() => {
      // best-effort stale socket cleanup after ownership is acquired
    });
    return {
      sessionId,
      lockPath,
      socketPath,
      createdAt,
      ownerGeneration,
      ...(parking ? { parking: true } : {}),
      ...(parkingMaxAgeMs === undefined ? {} : { parkingMaxAgeMs }),
      ...mcpConfigMetadata,
    };
  } finally {
    await fs.unlink(temporaryPath).catch(() => {
      // Best effort after publishing the completed lease through a hard link.
    });
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

export function refreshQueueOwnerLease(
  lease: QueueOwnerLease,
  options: {
    queueDepth: number;
  },
  nowIsoFactory: () => string = nowIso,
): Promise<void> {
  const state = queueOwnerLeaseMutationState(lease);
  if (state.releasing) {
    return Promise.resolve();
  }
  return enqueueQueueOwnerLeaseMutation(state, async () => {
    if (state.releasing) {
      return;
    }
    const payload = JSON.stringify(
      {
        pid: process.pid,
        sessionId: lease.sessionId,
        socketPath: lease.socketPath,
        createdAt: lease.createdAt,
        heartbeatAt: nowIsoFactory(),
        ownerGeneration: lease.ownerGeneration,
        queueDepth: Math.max(0, Math.round(options.queueDepth)),
        queueProtocol: QUEUE_PROTOCOL_VERSION,
        acpxVersion: getAcpxVersion(),
        ...(lease.parking ? { parking: true } : {}),
        ...(lease.parkingMaxAgeMs === undefined ? {} : { parkingMaxAgeMs: lease.parkingMaxAgeMs }),
        ...(lease.mcpConfigPath ? { mcpConfigPath: lease.mcpConfigPath } : {}),
        ...(lease.mcpConfigFingerprint ? { mcpConfigFingerprint: lease.mcpConfigFingerprint } : {}),
      },
      null,
      2,
    );
    const temporaryPath = createAtomicWriteTempPath(lease.lockPath);
    try {
      await fs.writeFile(temporaryPath, `${payload}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      if (!state.releasing) {
        await fs.rename(temporaryPath, lease.lockPath);
      }
    } finally {
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
  });
}

export function releaseQueueOwnerLease(lease: QueueOwnerLease): Promise<void> {
  const state = queueOwnerLeaseMutationState(lease);
  if (state.releasePromise) {
    return state.releasePromise;
  }
  state.releasing = true;
  state.releasePromise = enqueueQueueOwnerLeaseMutation(state, async () => {
    try {
      const expected = queueOwnerRecordIdentityForLease(lease);
      const result = await removeQueueOwnerRecordIfCurrent(lease.lockPath, expected);
      if (result === "failed") {
        throw new Error(`Failed to release queue owner lease for session ${lease.sessionId}`);
      }
      // SessionQueueOwner.close() removes its Unix socket. Do not unlink the
      // deterministic path here: after the identity-safe lock quarantine, a
      // legacy replacement may already have bound the same socket path.
    } catch (error) {
      // Teardown remains a one-way barrier for refreshes, but a transient
      // filesystem failure must not prevent a later release attempt.
      state.releasePromise = undefined;
      throw error;
    }
  });
  return state.releasePromise;
}

async function readQueueOwnerForTermination(
  sessionId: string,
): Promise<QueueOwnerRecord | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = await readQueueOwnerRecordState(sessionId);
    if (state.kind === "record") {
      return state.owner;
    }
    if (state.kind === "missing") {
      return undefined;
    }
    await waitMs(10);
  }
  throw new Error(`Failed to read queue owner for session ${sessionId}`);
}

export async function terminateQueueOwnerForSession(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner = await readQueueOwnerForTermination(sessionId);
    if (!owner) {
      return;
    }
    const result = await terminateQueueOwnerIfCurrent(sessionId, owner);
    if (result === "retired") {
      return;
    }
    if (result === "failed") {
      throw new Error(`Failed to terminate queue owner for session ${sessionId}`);
    }
    // A session-wide close owns replacement cleanup too. Re-read the record so
    // the next attempt targets the replacement's immutable identity.
  }
  throw new Error(`Queue owner changed repeatedly while terminating session ${sessionId}`);
}

function isSameQueueOwner(
  owner: QueueOwnerRecord | undefined,
  expected: QueueOwnerRecord,
): boolean {
  return owner?.pid === expected.pid && owner.ownerGeneration === expected.ownerGeneration;
}

export type QueueOwnerTerminationResult = "retired" | "replaced" | "failed";

function changedQueueOwnerResult(
  owner: QueueOwnerRecord | undefined,
  expected: QueueOwnerRecord,
): QueueOwnerTerminationResult | undefined {
  if (isSameQueueOwner(owner, expected)) {
    return undefined;
  }
  return owner ? "replaced" : "retired";
}

async function changedQueueOwnerResultFromDisk(
  sessionId: string,
  expected: QueueOwnerRecord,
): Promise<QueueOwnerTerminationResult | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = await readQueueOwnerRecordState(sessionId);
    if (state.kind === "record") {
      return changedQueueOwnerResult(state.owner, expected);
    }
    if (state.kind === "missing") {
      return "retired";
    }
    await waitMs(10);
  }
  return "failed";
}

async function terminateExpectedOwnerProcess(expected: QueueOwnerRecord): Promise<boolean> {
  if (!isProcessAlive(expected.pid)) {
    return true;
  }
  if (await terminateProcess(expected.pid)) {
    return true;
  }
  return !isProcessAlive(expected.pid);
}

function createRetiringOwnerQuarantinePath(lockPath: string): string {
  return `${lockPath}.retired.${process.pid}.${randomUUID()}`;
}

async function restoreQuarantinedQueueOwnerRecord(
  lockPath: string,
  quarantinePath: string,
): Promise<void> {
  try {
    await fs.link(quarantinePath, lockPath);
    await fs.unlink(quarantinePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOENT") {
      throw error;
    }
    // A newer owner may already hold the shared path. Keep this uniquely named
    // record rather than deleting a replacement whose identity we do not own.
  }
}

function queueOwnerRecordIdentityForLease(lease: QueueOwnerLease): QueueOwnerRecord {
  return {
    pid: process.pid,
    sessionId: lease.sessionId,
    socketPath: lease.socketPath,
    createdAt: lease.createdAt,
    heartbeatAt: lease.createdAt,
    ownerGeneration: lease.ownerGeneration,
    queueDepth: 0,
  };
}

async function removeQueueOwnerRecordIfCurrent(
  lockPath: string,
  expected: QueueOwnerRecord,
): Promise<QueueOwnerTerminationResult> {
  const quarantinePath = createRetiringOwnerQuarantinePath(lockPath);
  try {
    await fs.rename(lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "retired";
    }
    throw error;
  }

  const quarantined = await readQueueOwnerRecordStateAtPath(quarantinePath);
  if (quarantined.kind === "record" && isSameQueueOwner(quarantined.owner, expected)) {
    await fs.unlink(quarantinePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
    // Do not unlink the deterministic socket here. A legacy replacement can
    // publish after the atomic rename without honoring the retirement marker;
    // the next owner removes the dead socket only after acquiring the lock.
    return "retired";
  }

  await restoreQuarantinedQueueOwnerRecord(lockPath, quarantinePath);
  return quarantined.kind === "record" ? "replaced" : "failed";
}

async function retireMarkedQueueOwner(
  sessionId: string,
  lockPath: string,
  expected: QueueOwnerRecord,
): Promise<QueueOwnerTerminationResult> {
  const markedOwnerResult = await changedQueueOwnerResultFromDisk(sessionId, expected);
  if (markedOwnerResult) {
    return markedOwnerResult;
  }
  if (!(await terminateExpectedOwnerProcess(expected))) {
    return "failed";
  }
  const terminatedOwnerResult = await changedQueueOwnerResultFromDisk(sessionId, expected);
  if (terminatedOwnerResult) {
    return terminatedOwnerResult;
  }
  return await removeQueueOwnerRecordIfCurrent(lockPath, expected);
}

export async function terminateQueueOwnerIfCurrent(
  sessionId: string,
  expected: QueueOwnerRecord,
): Promise<QueueOwnerTerminationResult> {
  const lockPath = queueLockFilePath(sessionId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitForQueueOwnerRetirement(lockPath);
    const changedOwner = await changedQueueOwnerResultFromDisk(sessionId, expected);
    if (changedOwner) {
      return changedOwner;
    }

    const markerLease = await tryCreateRetirementMarker(lockPath, expected);
    if (!markerLease) {
      continue;
    }

    try {
      return await retireMarkedQueueOwner(sessionId, lockPath, expected);
    } finally {
      try {
        await removeOwnedRetirementMarkers(lockPath, markerLease.marker.markerId);
      } finally {
        await stopRetirementMarkerLiveness(markerLease);
      }
    }
  }

  return "failed";
}

export async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
