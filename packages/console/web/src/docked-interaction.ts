import { interactionAvailability } from "./interaction-availability";
import type { OwnerState, PendingInteraction } from "./types";

/**
 * Which waiting request the dock should show.
 *
 * The oldest request is the one that stalled the turn, so it leads. But a
 * request whose response already crossed the write boundary cannot be answered
 * again, and docking that one would park an unanswerable card in front of
 * requests the service is still willing to take. So the dock prefers the oldest
 * request that can actually be answered, and only falls back to the plain oldest
 * when none can.
 */
export const dockedInteraction = (
  pending: readonly PendingInteraction[],
  ownerState?: OwnerState,
): PendingInteraction | undefined => {
  const waiting = pending.filter((interaction) => interaction.state === "pending");
  return (
    waiting.find((interaction) => interactionAvailability(interaction, ownerState).answerable) ??
    waiting[0]
  );
};
