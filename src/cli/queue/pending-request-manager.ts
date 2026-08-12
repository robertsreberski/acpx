import { randomUUID } from "node:crypto";
import type { PermissionOption, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { PendingRequestNotAnswerableError } from "../../errors.js";
import { inferToolKind } from "../../permissions.js";
import {
  PENDING_REQUEST_SCHEMA,
  elicitationFieldNames,
  listPendingRequests,
  writePendingRequest,
  type PendingElicitationRequest,
  type PendingPermissionRequest,
  type PendingRequest,
  type PendingRequestAnswer,
  type PendingRequestOption,
  type PendingRequestResolutionSource,
  type PendingRequestState,
} from "../../session/pending-requests.js";
import type {
  AcpElicitationDecision,
  AcpElicitationRequest,
  AcpPermissionDecision,
  PermissionEscalationAction,
} from "../../types.js";

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

export type PendingElicitationParkInput = {
  request: AcpElicitationRequest;
  taskRequestId: string;
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

type ParkedShared = {
  timer?: NodeJS.Timeout;
  detachAbort?: () => void;
};

/**
 * A request this owner is blocked on, paired with the promise that unblocks it.
 *
 * Tagged by kind so the entry and the callback that settles it are narrowed
 * together: an elicitation can only ever be settled with an elicitation
 * decision, and the compiler is what enforces it rather than a cast.
 */
type ParkedRequest =
  | (ParkedShared & {
      kind: "permission";
      entry: PendingPermissionRequest;
      settle: (decision: AcpPermissionDecision) => void;
    })
  | (ParkedShared & {
      kind: "elicitation";
      entry: PendingElicitationRequest;
      settle: (decision: AcpElicitationDecision) => void;
    });

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

function offeredOptionIds(entry: PendingPermissionRequest): string {
  return entry.options.map((candidate) => candidate.optionId).join(", ");
}

type SettledFields = {
  state: Exclude<PendingRequestState, "pending">;
  optionId?: string;
  action?: string;
};

type ResolvedPermissionAnswer = SettledFields & { decision: AcpPermissionDecision };
type ResolvedElicitationAnswer = SettledFields & { decision: AcpElicitationDecision };

function resolveSelectAnswer(
  entry: PendingPermissionRequest,
  optionId: string,
): ResolvedPermissionAnswer {
  const option = entry.options.find((candidate) => candidate.optionId === optionId);
  if (!option) {
    throw new PendingRequestNotAnswerableError(
      `Option ${optionId} was not offered for request ${entry.requestId} ` +
        `(offered: ${offeredOptionIds(entry)})`,
    );
  }
  return {
    state: "answered",
    optionId: option.optionId,
    decision: { outcome: "select", optionId: option.optionId },
  };
}

/**
 * Turn an answer into the transition it stands for, for a permission request.
 *
 * `decline` answers with the agent's own reject option rather than a
 * synthesized outcome; when the agent offered none it is refused instead of
 * quietly downgraded to a cancel, because the two are different outcomes for
 * the agent and only the responder can choose between them.
 */
function resolvePermissionAnswer(
  entry: PendingPermissionRequest,
  answer: PendingRequestAnswer,
): ResolvedPermissionAnswer {
  if (answer.type === "select") {
    return resolveSelectAnswer(entry, answer.option_id);
  }
  if (answer.type === "accept") {
    throw new PendingRequestNotAnswerableError(
      `Request ${entry.requestId} is a permission request and is answered by choosing one of ` +
        `the options the agent offered; use --option, --decline or --cancel ` +
        `(offered: ${offeredOptionIds(entry)})`,
    );
  }
  if (answer.type === "cancel") {
    return { state: "cancelled", decision: { outcome: "cancel" } };
  }
  const rejectOption = pickRejectOption(entry.options);
  if (!rejectOption) {
    throw new PendingRequestNotAnswerableError(
      `Request ${entry.requestId} offers no rejection option to decline with; ` +
        `answer it with --option or --cancel (offered: ${offeredOptionIds(entry)})`,
    );
  }
  return {
    state: "answered",
    optionId: rejectOption.optionId,
    decision: { outcome: "select", optionId: rejectOption.optionId },
  };
}

/**
 * The same, for an elicitation.
 *
 * All three ACP actions are real answers the agent knows how to handle, so
 * unlike a permission decline there is nothing to synthesize and nothing to
 * refuse: `accept` carries the filled-in form, `decline` says the form was
 * skipped, and `cancel` abandons whatever the agent was asking for.
 */
function resolveElicitationAnswer(
  entry: PendingElicitationRequest,
  answer: PendingRequestAnswer,
): ResolvedElicitationAnswer {
  if (answer.type === "select") {
    throw new PendingRequestNotAnswerableError(
      `Request ${entry.requestId} is an elicitation and is answered by filling in its form, ` +
        `not by choosing an option; use --field, --text, --decline or --cancel ` +
        `(fields: ${elicitationFieldNames(entry).join(", ") || "none"})`,
    );
  }
  if (answer.type === "accept") {
    return {
      state: "answered",
      action: "accept",
      decision: { outcome: "accept", content: answer.content },
    };
  }
  if (answer.type === "cancel") {
    return { state: "cancelled", action: "cancel", decision: { outcome: "cancel" } };
  }
  return { state: "answered", action: "decline", decision: { outcome: "decline" } };
}

/**
 * Cancelling means the same thing in both vocabularies, and `{ outcome:
 * "cancel" }` is a member of both decision unions — so this type-checks against
 * either waiter's callback without a cast and without branching on the kind.
 */
function settleCancelled(parked: ParkedRequest): void {
  parked.settle({ outcome: "cancel" });
}

/**
 * An elicitation records which ACP action closed it, so a reader can tell a
 * cancelled form from a declined one. A permission request records the option
 * it was settled with, and a cancel settles it with none.
 */
function cancelledResolution(parked: ParkedRequest): { action?: string } {
  return parked.kind === "elicitation" ? { action: "cancel" } : {};
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
  /**
   * Waiters whose durable write has not landed yet. listPending() deliberately
   * ignores these so "a visible waiter implies a durable entry" still holds,
   * but cancelAll() drains them too — otherwise a SIGTERM inside the write
   * window leaves a promise nothing ever settles.
   */
  private readonly parking = new Map<string, ParkedRequest>();
  private readonly deferMaxAgeMs: number;
  private readonly ownerPid: number;

  constructor(options: PendingRequestManagerOptions) {
    this.options = options;
    this.deferMaxAgeMs = Math.max(0, Math.round(options.deferMaxAgeMs ?? DEFAULT_DEFER_MAX_AGE_MS));
    this.ownerPid = options.ownerPid ?? process.pid;
  }

  /**
   * Park a permission request until something answers it, it expires, or the
   * turn is cancelled.
   *
   * listPending() reports a waiter only after its write has been attempted, so
   * a visible waiter normally implies a durable entry. It is not a guarantee:
   * completePark swallows a write failure rather than stranding the agent, so a
   * disk error yields a waiter with no file. Unblocking the turn is worth more
   * than the invariant.
   */
  async park(
    input: PendingRequestParkInput,
    ctx: { signal: AbortSignal },
  ): Promise<AcpPermissionDecision> {
    const entry = this.buildEntry(input);
    return await new Promise<AcpPermissionDecision>((resolve) => {
      const parked: ParkedRequest = { kind: "permission", entry, settle: resolve };
      this.parking.set(entry.requestId, parked);
      void this.completePark(parked, ctx.signal);
    });
  }

  /**
   * Park a form elicitation. Same lifecycle as a permission request in every
   * respect that matters here — durable entry, expiry, abort, shutdown — and
   * the same reason for existing: the alternative to parking is answering the
   * agent on the operator's behalf, which for a form means making up content.
   */
  async parkElicitation(
    input: PendingElicitationParkInput,
    ctx: { signal: AbortSignal },
  ): Promise<AcpElicitationDecision> {
    const entry = this.buildElicitationEntry(input);
    return await new Promise<AcpElicitationDecision>((resolve) => {
      const parked: ParkedRequest = { kind: "elicitation", entry, settle: resolve };
      this.parking.set(entry.requestId, parked);
      void this.completePark(parked, ctx.signal);
    });
  }

  private async completePark(parked: ParkedRequest, signal: AbortSignal): Promise<void> {
    const { entry } = parked;
    await writePendingRequest(entry).catch(() => {
      // Recorded below as a settled request either way; a disk failure must not
      // leave the agent blocked forever.
    });
    if (!this.parking.delete(entry.requestId)) {
      // cancelAll took it while the write was in flight; it already settled.
      return;
    }
    this.emit("created", entry);

    if (signal.aborted) {
      await this.settleEntry(entry, "cancelled", "cancel", cancelledResolution(parked));
      settleCancelled(parked);
      return;
    }

    this.parked.set(entry.requestId, parked);
    this.attachAbort(parked, signal);
    this.attachExpiry(parked);
  }

  /**
   * Answer a parked request. Returns the terminal entry so a responder does not
   * have to re-read the store to learn what it just did.
   *
   * The answer is resolved before the request is released, so an answer the
   * request cannot take — an option id for a form, a form for a permission
   * request — leaves it parked and still answerable.
   */
  async respond(requestId: string, answer: PendingRequestAnswer): Promise<PendingRequest> {
    const parked = this.parked.get(requestId);
    if (!parked) {
      throw new PendingRequestNotAnswerableError(
        `No pending request ${requestId} is awaiting an answer on this session`,
      );
    }

    if (parked.kind === "elicitation") {
      const resolved = resolveElicitationAnswer(parked.entry, answer);
      this.release(parked);
      const settled = await this.settleEntry(parked.entry, resolved.state, "cli", resolved);
      parked.settle(resolved.decision);
      return settled;
    }

    const resolved = resolvePermissionAnswer(parked.entry, answer);
    this.release(parked);
    const settled = await this.settleEntry(parked.entry, resolved.state, "cli", resolved);
    parked.settle(resolved.decision);
    return settled;
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
    const parked = [...this.parked.values(), ...this.parking.values()];
    for (const entry of parked) {
      this.parking.delete(entry.entry.requestId);
      this.release(entry);
    }
    for (const entry of parked) {
      await this.settleEntry(entry.entry, "cancelled", reason, cancelledResolution(entry));
      settleCancelled(entry);
    }
  }

  private buildToolCall(request: RequestPermissionRequest): PendingPermissionRequest["toolCall"] {
    const toolKind = inferToolKind(request);
    const title = request.toolCall.title?.trim() || "tool";
    return {
      toolCallId: request.toolCall.toolCallId,
      title,
      ...(toolKind ? { kind: toolKind } : {}),
      ...(request.toolCall.rawInput !== undefined ? { rawInput: request.toolCall.rawInput } : {}),
    };
  }

  /** Everything an entry carries before its kind-specific half. */
  private buildEntryBase(taskRequestId: string, acpSessionId: string) {
    const now = this.options.now?.() ?? new Date();
    const createdAt = now.toISOString();
    return {
      schema: PENDING_REQUEST_SCHEMA,
      requestId: this.options.createRequestId?.() ?? randomUUID(),
      sessionId: this.options.sessionId,
      acpSessionId,
      agentCommand: this.options.agentCommand,
      cwd: this.options.cwd,
      state: "pending",
      createdAt,
      updatedAt: createdAt,
      ...(this.deferMaxAgeMs > 0
        ? { expiresAt: new Date(now.getTime() + this.deferMaxAgeMs).toISOString() }
        : {}),
      ownerPid: this.ownerPid,
      ownerGeneration: this.options.ownerGeneration,
      taskRequestId,
    } as const satisfies Partial<PendingRequest>;
  }

  private buildEntry(input: PendingRequestParkInput): PendingPermissionRequest {
    return {
      // The request's own sessionId is authoritative: the owner's boot-time
      // record goes stale the moment a reconnect reassigns acpSessionId.
      ...this.buildEntryBase(
        input.taskRequestId,
        input.request.sessionId || this.options.acpSessionId,
      ),
      kind: "permission",
      toolCall: this.buildToolCall(input.request),
      options: toPendingOptions(input.request),
    };
  }

  private buildElicitationEntry(input: PendingElicitationParkInput): PendingElicitationRequest {
    const { request } = input;
    return {
      ...this.buildEntryBase(input.taskRequestId, request.sessionId || this.options.acpSessionId),
      kind: "elicitation",
      elicitation: {
        message: request.message,
        mode: "form",
        // Stored exactly as the agent sent it: a responder answers against this
        // schema, so any normalization here is a field they cannot fill in.
        requestedSchema: request.requestedSchema,
        ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      },
    };
  }

  private attachAbort(parked: ParkedRequest, signal: AbortSignal): void {
    const onAbort = (): void => {
      if (!this.parked.has(parked.entry.requestId)) {
        return;
      }
      this.release(parked);
      void this.settleEntry(
        parked.entry,
        "cancelled",
        "cancel",
        cancelledResolution(parked),
      ).finally(() => {
        settleCancelled(parked);
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
      this.expireParked(parked);
    }, this.deferMaxAgeMs);
    // The expiry timer must never be the reason the process stays alive.
    timer.unref?.();
    parked.timer = timer;
  }

  /**
   * Settle a request nobody answered in time.
   *
   * Expiry never approves and never accepts. A permission request falls to the
   * agent's own rejection option, and an elicitation declines — which is ACP's
   * "the user skipped this form", the only truthful thing to say when nobody
   * filled it in. Synthesizing content would put words in the operator's mouth.
   */
  private expireParked(parked: ParkedRequest): void {
    if (parked.kind === "elicitation") {
      void this.settleEntry(parked.entry, "expired", "expiry", { action: "decline" }).finally(
        () => {
          parked.settle({ outcome: "decline" });
        },
      );
      return;
    }
    const rejectOption = pickRejectOption(parked.entry.options);
    void this.settleEntry(
      parked.entry,
      "expired",
      "expiry",
      rejectOption ? { optionId: rejectOption.optionId } : {},
    ).finally(() => {
      parked.settle(
        rejectOption
          ? { outcome: "select", optionId: rejectOption.optionId }
          : { outcome: "cancel" },
      );
    });
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
    resolution: { optionId?: string; action?: string },
  ): Promise<PendingRequest> {
    const answeredAt = (this.options.now?.() ?? new Date()).toISOString();
    const settled: PendingRequest = {
      ...entry,
      state,
      updatedAt: answeredAt,
      resolution: {
        answeredAt,
        source,
        ...(resolution.optionId ? { optionId: resolution.optionId } : {}),
        ...(resolution.action ? { action: resolution.action } : {}),
      },
    };
    await writePendingRequest(settled).catch(() => {
      // A store write failure must not strand the ACP turn; the in-memory
      // settle below still unblocks the agent.
    });
    this.emit(state === "answered" ? "answered" : stateEventType(state), settled);
    return settled;
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
