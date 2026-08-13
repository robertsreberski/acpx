import type { TranscriptEvent } from "./types";

/**
 * Which projected events belong in the transcript.
 *
 * The ledger is deliberately lossless and keeps every ACP envelope, but most of
 * them are transport: `initialize`, `session/resume`, `session/set_mode`,
 * command and mode update notifications, turn lifecycle markers. Rendering those
 * as activity rows makes the agent's actual work harder to follow, and they are
 * indistinguishable from real tool calls once rendered.
 *
 * This is an allow-list rather than a deny-list because ACP method names are
 * open-ended: a deny-list would let every new protocol method leak into the
 * conversation. Nothing is discarded — `timeline.events` still carries the
 * complete record, and the durable transcript is untouched.
 */
const CONVERSATION_KINDS: ReadonlySet<string> = new Set([
  "message",
  "text",
  "reasoning",
  "plan",
  "tool_call",
  "permission",
  "elicitation",
  // Failures and truncation are not transport noise: they explain a gap in the
  // conversation, so they stay visible.
  "jsonrpc_error",
  "timeline_truncated",
  "history_gap",
]);

export const isConversationEvent = (event: TranscriptEvent): boolean =>
  CONVERSATION_KINDS.has(event.kind);

export const conversationEvents = (
  events: readonly TranscriptEvent[],
): readonly TranscriptEvent[] => events.filter((event) => isConversationEvent(event));
