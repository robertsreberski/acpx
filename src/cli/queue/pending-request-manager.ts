import { randomUUID } from "node:crypto";
import type { PermissionOption, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { PendingRequestNotAnswerableError } from "../../errors.js";
import { inferToolKind } from "../../permissions.js";
import {
  PENDING_REQUEST_SCHEMA,
  listPendingRequests,
  writePendingRequest,
  type PendingRequest,
  type PendingRequestOption,
  type PendingRequestResolutionSource,
  type PendingRequestState,
} from "../../session/pending-requests.js";
import type { AcpPermissionDecision, PermissionEscalationAction } from "../../types.js";

export const PENDING_REQUEST_EVENT_TYPES = [
  "created",
  "answered",
  "expired",
  "cancelled",
  "orphaned",
] as const;
export type PendingRequestEventType = (typeof PENDING_REQUEST_EVENT_TYPES)[number];

export type PendingRequestEvent = {
  type: "pending_request";
  event: PendingRequestEventType;
  request: PendingRequest;
};

export type PendingRequestParkInput = {
  request: RequestPermissionRequest;
  taskRequestId: string;
  action: PermissionEscalationAction;
};

export type PendingRequestManagerOptions = {
  sessionId: string;
  acpSessionId: string;
  agentCommand: string;
  cwd: string;
  ownerGeneration: number;
  ownerPid?: number;
  /** Milliseconds before a parked request expires; 0 parks indefinitely. */
  deferMaxAgeMs?: number;
  onEvent?: (event: PendingRequestEvent) => void;
  log?: (message: string) => void;
  now?: () => Date;
  createRequestId?: () => string;
};

export const DEFAULT_DEFER_MAX_AGE_MS = 86_400_000;

type ParkedRequest = {
  entry: PendingRequest;
  settle: (decision: AcpPermissionDecision) => void;
  timer?: NodeJS.Timeout;
  detachAbort?: () => void;
};

/** Reject kinds in the order the expiry path prefers them. */
const EXPIRY_REJECT_KINDS: PermissionOption["kind"][] = ["reject_once", "reject_always"];

function toPendingOptions(request: RequestPermissionRequest): PendingRequestOption[] {
  return (request.options ?? []).map((option) => ({
    optionId: option.optionId,
    name: option.name,
    kind: option.kind,
  }));
}

function pickRejectOption(options: PendingRequestOption[]): PendingRequestOption | undefined {
  for (const kind of EXPIRY_REJECT_KINDS) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return match;
    }
  }
  return undefined;
}

/**
 * Owns the parked permission requests of one queue owner: the durable entry,
 * the promise the ACP handler is blocked on, and the transitions between them.
 *
 * The owner that parked a request is its only writer. Nothing here touches
 * entries belonging to another owner generation.
 */
export class PendingRequestManager {
  private readonly options: PendingRequestManagerOptions;
  private readonly parked = new Map<string, ParkedRequest>();
  private readonly deferMaxAgeMs: number;
  private readonly ownerPid: number;

  constructor(options: PendingRequestManagerOptions) {
    this.options = options;
    this.deferMaxAgeMs = Math.max(0, Math.round(options.deferMaxAgeMs ?? DEFAULT_DEFER_MAX_AGE_MS));
    this.ownerPid = options.ownerPid ?? process.pid;
  }

  /**
   * Park a permission request until something answers it, it expires, or the
   * turn is cancelled. The durable entry is written before the returned promise
   * is handed back, so a lister can never observe a turn blocked on a request
   * that is not yet on disk.
   */
  async park(
    input: PendingRequestParkInput,
    ctx: { signal: AbortSignal },
  ): Promise<AcpPermissionDecision> {
    const entry = this.buildEntry(input);
    await writePendingRequest(entry);
    this.emit("created", entry);

    if (ctx.signal.aborted) {
      await this.settleEntry(entry, "cancelled", "cancel", undefined);
      return { outcome: "cancel" };
    }

    return await new Promise<AcpPermissionDecision>((resolve) => {
      const parked: ParkedRequest = { entry, settle: resolve };
      this.parked.set(entry.requestId, parked);
      this.attachAbort(parked, ctx.signal);
      this.attachExpiry(parked);
    });
  }

  /** Answer a parked request with one of the options the agent offered. */
  async respond(requestId: string, answer: { optionId: string }): Promise<void> {
    const parked = this.parked.get(requestId);
    if (!parked) {
      throw new PendingRequestNotAnswerableError(
        `No pending request ${requestId} is awaiting an answer on this session`,
      );
    }
    const option = parked.entry.options.find((candidate) => candidate.optionId === answer.optionId);
    if (!option) {
      const offered = parked.entry.options.map((candidate) => candidate.optionId).join(", ");
      throw new PendingRequestNotAnswerableError(
        `Option ${answer.optionId} was not offered for request ${requestId} (offered: ${offered})`,
      );
    }

    this.release(parked);
    await this.settleEntry(parked.entry, "answered", "cli", option.optionId);
    parked.settle({ outcome: "select", optionId: option.optionId });
  }

  /** Requests this owner is currently blocked on, newest state first read. */
  async listPending(): Promise<PendingRequest[]> {
    return await Promise.resolve([...this.parked.values()].map((parked) => parked.entry));
  }

  /** Every entry this owner's session has on disk, whatever its state. */
  async listStored(): Promise<PendingRequest[]> {
    return await listPendingRequests(this.options.sessionId);
  }

  /**
   * Unwind everything still parked. Called during owner shutdown before the
   * active turn is drained, so a turn blocked on a parked request can settle
   * inside the shutdown grace instead of being killed.
   */
  async cancelAll(reason: "shutdown" | "cancel"): Promise<void> {
    const parked = [...this.parked.values()];
    for (const entry of parked) {
      this.release(entry);
    }
    for (const entry of parked) {
      await this.settleEntry(entry.entry, "cancelled", reason, undefined);
      entry.settle({ outcome: "cancel" });
    }
  }

  private buildToolCall(request: RequestPermissionRequest): PendingRequest["toolCall"] {
    const toolKind = inferToolKind(request);
    const title = request.toolCall.title?.trim() || "tool";
    return {
      toolCallId: request.toolCall.toolCallId,
      title,
      ...(toolKind ? { kind: toolKind } : {}),
      ...(request.toolCall.rawInput !== undefined ? { rawInput: request.toolCall.rawInput } : {}),
    };
  }

  private buildEntry(input: PendingRequestParkInput): PendingRequest {
    const now = this.options.now?.() ?? new Date();
    const createdAt = now.toISOString();
    return {
      schema: PENDING_REQUEST_SCHEMA,
      requestId: this.options.createRequestId?.() ?? randomUUID(),
      sessionId: this.options.sessionId,
      acpSessionId: this.options.acpSessionId,
      agentCommand: this.options.agentCommand,
      cwd: this.options.cwd,
      kind: "permission",
      state: "pending",
      createdAt,
      updatedAt: createdAt,
      ...(this.deferMaxAgeMs > 0
        ? { expiresAt: new Date(now.getTime() + this.deferMaxAgeMs).toISOString() }
        : {}),
      ownerPid: this.ownerPid,
      ownerGeneration: this.options.ownerGeneration,
      taskRequestId: input.taskRequestId,
      toolCall: this.buildToolCall(input.request),
      options: toPendingOptions(input.request),
    };
  }

  private attachAbort(parked: ParkedRequest, signal: AbortSignal): void {
    const onAbort = (): void => {
      if (!this.parked.has(parked.entry.requestId)) {
        return;
      }
      this.release(parked);
      void this.settleEntry(parked.entry, "cancelled", "cancel", undefined).finally(() => {
        parked.settle({ outcome: "cancel" });
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    parked.detachAbort = () => signal.removeEventListener("abort", onAbort);
  }

  private attachExpiry(parked: ParkedRequest): void {
    if (this.deferMaxAgeMs <= 0) {
      return;
    }
    const timer = setTimeout(() => {
      if (!this.parked.has(parked.entry.requestId)) {
        return;
      }
      this.release(parked);
      const rejectOption = pickRejectOption(parked.entry.options);
      void this.settleEntry(parked.entry, "expired", "expiry", rejectOption?.optionId).finally(
        () => {
          parked.settle(
            rejectOption
              ? { outcome: "select", optionId: rejectOption.optionId }
              : { outcome: "cancel" },
          );
        },
      );
    }, this.deferMaxAgeMs);
    // The expiry timer must never be the reason the process stays alive.
    timer.unref?.();
    parked.timer = timer;
  }

  private release(parked: ParkedRequest): void {
    this.parked.delete(parked.entry.requestId);
    if (parked.timer) {
      clearTimeout(parked.timer);
      parked.timer = undefined;
    }
    parked.detachAbort?.();
    parked.detachAbort = undefined;
  }

  private async settleEntry(
    entry: PendingRequest,
    state: Exclude<PendingRequestState, "pending">,
    source: PendingRequestResolutionSource,
    optionId: string | undefined,
  ): Promise<void> {
    const answeredAt = (this.options.now?.() ?? new Date()).toISOString();
    const settled: PendingRequest = {
      ...entry,
      state,
      updatedAt: answeredAt,
      resolution: {
        answeredAt,
        source,
        ...(optionId ? { optionId } : {}),
      },
    };
    await writePendingRequest(settled).catch(() => {
      // A store write failure must not strand the ACP turn; the in-memory
      // settle below still unblocks the agent.
    });
    this.emit(state === "answered" ? "answered" : stateEventType(state), settled);
  }

  private emit(event: PendingRequestEventType, request: PendingRequest): void {
    try {
      this.options.onEvent?.({ type: "pending_request", event, request });
    } catch (error) {
      // Report-only channel. A consumer that throws must not abort a
      // transition, strand the parked turn, or take down owner shutdown.
      this.options.log?.(
        `pending request event consumer threw for ${event} ${request.requestId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function stateEventType(state: Exclude<PendingRequestState, "pending">): PendingRequestEventType {
  return state === "answered" ? "answered" : state;
}
