import type { TranscriptEvent } from "./types";

export interface QueuedPrompt {
  readonly id: string;
  readonly sessionId: string;
  readonly text: string;
}

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

/** Preserve a just-accepted optimistic row while the owner lease depth catches up. */
export const mergeSessionQueuedProjection = (
  prompts: readonly QueuedPrompt[],
  sessionId: string,
  queueDepth: number,
  durable: readonly { readonly id: string; readonly text: string }[],
): readonly QueuedPrompt[] => {
  const optimistic = prompts.filter((prompt) => prompt.sessionId === sessionId);
  return durable.length === 0 && queueDepth < optimistic.length
    ? prompts
    : replaceSessionQueuedPrompts(prompts, sessionId, durable);
};
