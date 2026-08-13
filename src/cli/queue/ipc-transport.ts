import net from "node:net";
import { measurePerf } from "../../perf-metrics.js";
import { type QueueOwnerRecord, waitMs } from "./lease-store.js";

const QUEUE_CONNECT_ATTEMPTS = 40;
export const QUEUE_CONNECT_RETRY_MS = 50;
export const SOCKET_CONNECTION_TIMEOUT_MS = 5000;

export function shouldRetryQueueConnect(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EAGAIN";
}

async function connectToSocket(
  socketPath: string,
  timeoutMs = SOCKET_CONNECTION_TIMEOUT_MS,
): Promise<net.Socket> {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(new Error(`Connection to ${socketPath} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onConnect = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.off("error", onError);
      resolve(socket);
    };
    const onError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

/**
 * One budget for one whole owner request.
 *
 * Connecting and waiting for the reply spend the same allowance: a caller that
 * asked to stop waiting after N ms means N ms in total. A wedged owner withholds
 * a connect as readily as it withholds a reply — a suspended process whose
 * listen backlog has filled up refuses connects outright — so a bound that only
 * covers the reply is no bound at all in exactly the case it exists for.
 */
export type QueueRequestBudget = {
  /** Milliseconds left, sampled now. Zero or less once spent. */
  remainingMs: () => number;
  /** The error to raise when the budget runs out before the socket is up. */
  expired: () => Error;
};

/**
 * The timeout for one connect attempt, capped by whatever budget is left.
 *
 * Throws when the budget is already spent: there is no attempt left to make,
 * and the caller asked to hear about it as a timeout rather than as whatever
 * the next refused connect would have reported.
 */
function connectAttemptTimeoutMs(budget: QueueRequestBudget | undefined): number {
  if (!budget) {
    return SOCKET_CONNECTION_TIMEOUT_MS;
  }
  const remainingMs = budget.remainingMs();
  if (remainingMs <= 0) {
    throw budget.expired();
  }
  return Math.min(SOCKET_CONNECTION_TIMEOUT_MS, remainingMs);
}

/**
 * Decide what a failed connect attempt means: return to retry, throw otherwise.
 *
 * A per-attempt timeout the budget capped is the budget running out, not a
 * transport failure of its own. Any other non-retryable error is still reported
 * as itself, budget or no budget.
 */
function assertConnectAttemptRetryable(
  error: unknown,
  budget: QueueRequestBudget | undefined,
): void {
  if (!shouldRetryQueueConnect(error)) {
    if (budget && budget.remainingMs() <= 0) {
      throw budget.expired();
    }
    throw error;
  }
  if (budget && budget.remainingMs() <= QUEUE_CONNECT_RETRY_MS) {
    // Waiting before the next attempt would itself outrun what is left.
    throw budget.expired();
  }
}

export async function connectToQueueOwner(
  owner: QueueOwnerRecord,
  maxAttempts = QUEUE_CONNECT_ATTEMPTS,
  budget?: QueueRequestBudget,
): Promise<net.Socket | undefined> {
  let lastError: unknown;

  const attempts = Math.max(1, Math.trunc(maxAttempts));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const timeoutMs = connectAttemptTimeoutMs(budget);
    try {
      return await measurePerf(
        "queue.connect",
        async () => await connectToSocket(owner.socketPath, timeoutMs),
      );
    } catch (error) {
      lastError = error;
      assertConnectAttemptRetryable(error, budget);
      await waitMs(QUEUE_CONNECT_RETRY_MS);
    }
  }

  if (lastError && !shouldRetryQueueConnect(lastError)) {
    throw lastError;
  }

  return undefined;
}
