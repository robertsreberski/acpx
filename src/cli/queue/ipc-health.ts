import { connectToQueueOwner } from "./ipc-transport.js";
import {
  isQueueOwnerHeartbeatStale,
  readLiveQueueOwner,
  readQueueOwnerRecord,
  readQueueOwnerStatus,
  type QueueOwnerRecord,
} from "./lease-store.js";

export type QueueOwnerHealth = {
  sessionId: string;
  hasLease: boolean;
  healthy: boolean;
  socketReachable: boolean;
  pidAlive: boolean;
  pid?: number;
  socketPath?: string;
  ownerGeneration?: number;
  queueDepth?: number;
};

type QueueOwnerHealthOwner = {
  pid: number;
  socketPath: string;
  ownerGeneration: number;
  queueDepth: number;
  alive: boolean;
};

function noQueueOwnerHealth(sessionId: string): QueueOwnerHealth {
  return {
    sessionId,
    hasLease: false,
    healthy: false,
    socketReachable: false,
    pidAlive: false,
  };
}

async function readHealthOwner(
  sessionId: string,
  retireStaleOwner: boolean,
): Promise<QueueOwnerHealthOwner | undefined> {
  if (retireStaleOwner) {
    const status = await readQueueOwnerStatus(sessionId);
    return status && { ...status };
  }
  const owner = await readLiveQueueOwner(sessionId);
  return (
    owner && {
      pid: owner.pid,
      socketPath: owner.socketPath,
      ownerGeneration: owner.ownerGeneration,
      queueDepth: owner.queueDepth,
      alive: true,
    }
  );
}

async function isSocketReachable(ownerRecord: QueueOwnerRecord): Promise<boolean> {
  try {
    const socket = await connectToQueueOwner(ownerRecord, 2);
    if (!socket) {
      return false;
    }
    // Destroy rather than end: a half-closed socket to an owner that is not
    // reading keeps a handle open, and the probing process then never exits.
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}

async function queueOwnerHealth(
  sessionId: string,
  retireStaleOwner: boolean,
): Promise<QueueOwnerHealth> {
  const ownerRecord = await readQueueOwnerRecord(sessionId);
  if (!ownerRecord) {
    return noQueueOwnerHealth(sessionId);
  }

  const owner = await readHealthOwner(sessionId, retireStaleOwner);
  if (!owner) {
    return noQueueOwnerHealth(sessionId);
  }

  const socketReachable = await isSocketReachable(ownerRecord);
  // A suspended owner still accepts connections — the kernel completes them
  // without the process running — so reachability alone cannot tell a working
  // owner from a stopped one. The heartbeat can: it only advances while the
  // owner's event loop runs. The takeover probe never sees a stale one, because
  // it retires those before getting here.
  const answering = socketReachable && !isQueueOwnerHeartbeatStale(ownerRecord);
  return {
    sessionId,
    hasLease: true,
    healthy: answering,
    socketReachable,
    pidAlive: owner.alive,
    pid: owner.pid,
    socketPath: owner.socketPath,
    ownerGeneration: owner.ownerGeneration,
    queueDepth: owner.queueDepth,
  };
}

/**
 * Health as seen by a caller that is about to take the session over.
 *
 * This one RETIRES an owner whose heartbeat has gone stale — SIGTERM, SIGKILL,
 * lease deleted — which is correct when the next step is starting or replacing
 * the owner, and destructive everywhere else. Only action verbs (submit,
 * cancel, close, and the session-control setters) may use it; anything that
 * merely reports must use `inspectQueueOwnerHealth`.
 */
export async function probeQueueOwnerHealth(sessionId: string): Promise<QueueOwnerHealth> {
  return await queueOwnerHealth(sessionId, true);
}

/**
 * Health as seen by a caller that only wants to look: same fields, no side
 * effects. A live owner that is busy, suspended, or slow to heartbeat is
 * reported as leased and unreachable rather than killed and forgotten.
 */
export async function inspectQueueOwnerHealth(sessionId: string): Promise<QueueOwnerHealth> {
  return await queueOwnerHealth(sessionId, false);
}
