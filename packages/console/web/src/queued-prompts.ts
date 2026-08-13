import type { TranscriptEvent } from "./types";

export interface QueuedPrompt {
  readonly id: string;
  readonly sessionId: string;
  readonly text: string;
  /** Browser monotonic time used only to bound post-acceptance projection lag. */
  readonly optimisticSince?: number;
}

export const OPTIMISTIC_QUEUE_GRACE_MS = 3_000;

const isWithinOptimisticGrace = (prompt: QueuedPrompt, now: number): boolean =>
  prompt.optimisticSince !== undefined &&
  now >= prompt.optimisticSince &&
  now - prompt.optimisticSince <= OPTIMISTIC_QUEUE_GRACE_MS;

/** Expire post-acceptance placeholders even when no further server invalidation arrives. */
export const expireOptimisticQueuedPrompts = (
  prompts: readonly QueuedPrompt[],
  now: number,
): readonly QueuedPrompt[] =>
  prompts.filter(
    (prompt) => prompt.optimisticSince === undefined || isWithinOptimisticGrace(prompt, now),
  );

export const unavailableQueuedControlsMessage = (
  queueDepth: number,
  exactTurnCount: number,
): string | undefined => {
  const unavailableCount = Math.max(0, queueDepth - exactTurnCount);
  return unavailableCount > 0
    ? `${unavailableCount} queued follow-up${unavailableCount === 1 ? "" : "s"} ${unavailableCount === 1 ? "has" : "have"} no exact control while the queue owner is reconciling or unavailable.`
    : undefined;
};

/** Remove exactly one optimistic receipt without disturbing another session or turn. */
export const removeQueuedPrompt = (
  prompts: readonly QueuedPrompt[],
  sessionId: string,
  turnId: string,
): readonly QueuedPrompt[] =>
  prompts.filter((prompt) => prompt.sessionId !== sessionId || prompt.id !== turnId);

const TERMINAL_TURN_STATES = new Set(["cancelled", "completed", "failed", "interrupted"]);

/** Keep optimistic queue receipts until the durable transcript starts or terminates that turn. */
export const reconcileQueuedPrompts = (
  prompts: readonly QueuedPrompt[],
  events: readonly TranscriptEvent[],
): readonly QueuedPrompt[] => {
  const durableTurnIds = new Set(
    events.flatMap((event) =>
      event.turnId &&
      ((event.kind === "message" && event.role === "user") ||
        (event.kind === "lifecycle" && TERMINAL_TURN_STATES.has(event.status ?? "")))
        ? [event.turnId]
        : [],
    ),
  );
  return prompts.filter((prompt) => !durableTurnIds.has(prompt.id));
};

/** Reconcile only the selected session without discarding receipts owned by other sessions. */
export const reconcileSessionQueuedPrompts = (
  prompts: readonly QueuedPrompt[],
  sessionId: string,
  events: readonly TranscriptEvent[],
): readonly QueuedPrompt[] => {
  const selected = reconcileQueuedPrompts(
    prompts.filter((prompt) => prompt.sessionId === sessionId),
    events,
  );
  return [...prompts.filter((prompt) => prompt.sessionId !== sessionId), ...selected];
};

/** Replace one session's optimistic receipts with the durable service projection. */
export const replaceSessionQueuedPrompts = (
  prompts: readonly QueuedPrompt[],
  sessionId: string,
  durable: readonly { readonly id: string; readonly text: string }[],
): readonly QueuedPrompt[] => [
  ...prompts.filter((prompt) => prompt.sessionId !== sessionId),
  ...durable.map((prompt) => ({ ...prompt, sessionId })),
];

type QueueProjectionOwnerState = "absent" | "starting" | "online" | "unreachable" | "dead";

/** Preserve a just-accepted optimistic row only while its online owner projection catches up. */
export const mergeSessionQueuedProjection = (
  prompts: readonly QueuedPrompt[],
  sessionId: string,
  ownerState: QueueProjectionOwnerState,
  durable: readonly { readonly id: string; readonly text: string }[],
  now: number,
): readonly QueuedPrompt[] => {
  const optimistic = prompts.filter((prompt) => prompt.sessionId === sessionId);
  if (durable.length > 0) {
    return replaceSessionQueuedPrompts(prompts, sessionId, durable);
  }
  const withinGrace = optimistic.filter((prompt) => isWithinOptimisticGrace(prompt, now));
  return ownerState === "online" && withinGrace.length > 0
    ? [...prompts.filter((prompt) => prompt.sessionId !== sessionId), ...withinGrace]
    : replaceSessionQueuedPrompts(prompts, sessionId, durable);
};
