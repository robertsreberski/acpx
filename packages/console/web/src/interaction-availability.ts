import type { OwnerState, PendingInteraction } from "./types";

export interface InteractionAvailability {
  readonly answerable: boolean;
  readonly reason?: string;
}

export const interactionAvailability = (
  interaction: PendingInteraction,
  ownerState: OwnerState | undefined,
): InteractionAvailability => {
  if (interaction.state !== "pending") {
    return { answerable: false, reason: `This request is ${interaction.state}.` };
  }
  if (ownerState !== "online") {
    const label = ownerState === undefined ? "not available" : ownerState;
    return {
      answerable: false,
      reason: `The queue owner is ${label}. This durable request is visible, but no live turn can receive an answer.`,
    };
  }
  return { answerable: true };
};
