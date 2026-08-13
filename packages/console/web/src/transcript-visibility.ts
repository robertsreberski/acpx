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

/** The requests that open a provider session. */
const ESTABLISHMENT_KINDS: ReadonlySet<string> = new Set([
  "session/resume",
  "session/load",
  "session/new",
]);

/**
 * Errors that acpx already recovered from.
 *
 * Reconnecting to a retained session normally starts with `session/resume`. When
 * the agent has expired its side it answers `-32002 Resource not found`, and
 * acpx immediately falls back to `session/new`, which succeeds. That is the
 * reconnect path working, but the refused attempt is a JSON-RPC error envelope
 * like any other, so the transcript opened with "ACP request failed" on almost
 * every start.
 *
 * An establishment error is treated as recovered only when a later
 * establishment attempt actually succeeded. If none did, the session never
 * opened and the error is the only explanation the operator has, so it stays.
 */
const recoveredEstablishmentErrors = (events: readonly TranscriptEvent[]): ReadonlySet<string> => {
  const methodByRequest = new Map<string, string>();
  for (const event of events) {
    if (event.requestId && ESTABLISHMENT_KINDS.has(event.kind)) {
      methodByRequest.set(event.requestId, event.kind);
    }
  }
  const failedRequests = new Set(
    events.flatMap((event) =>
      event.kind === "jsonrpc_error" && event.requestId ? [event.requestId] : [],
    ),
  );
  // The last attempt that opened a session, in timeline order.
  const lastSuccessfulAttempt = events.reduce<number | undefined>(
    (latest, event) =>
      event.requestId && ESTABLISHMENT_KINDS.has(event.kind) && !failedRequests.has(event.requestId)
        ? event.sequence
        : latest,
    undefined,
  );
  if (lastSuccessfulAttempt === undefined) {
    return new Set();
  }
  return new Set(
    events.flatMap((event) =>
      event.kind === "jsonrpc_error" &&
      event.requestId !== undefined &&
      methodByRequest.has(event.requestId) &&
      event.sequence < lastSuccessfulAttempt
        ? [event.id]
        : [],
    ),
  );
};

export const conversationEvents = (
  events: readonly TranscriptEvent[],
): readonly TranscriptEvent[] => {
  const recovered = recoveredEstablishmentErrors(events);
  return events.filter((event) => isConversationEvent(event) && !recovered.has(event.id));
};
