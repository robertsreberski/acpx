import type { TranscriptEvent } from "./types";

export interface QueuedPrompt {
  readonly id: string;
  readonly sessionId: string;
  readonly text: string;
}

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
