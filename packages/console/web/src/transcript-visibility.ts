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
 * Recovery has to be *observed*, never inferred from the absence of a second
 * error: a fallback whose response has not been paged in yet has no error
 * either, and treating that as success would hide the very failure the operator
 * needs. So an establishment error is hidden only when the connection is seen
 * doing something afterwards that only a live session produces.
 *
 * JSON-RPC ids restart at zero on every connection, so an error is paired with
 * the *nearest preceding* establishment request carrying that id rather than
 * any request that ever used it. Without that, one reconnect's failure would be
 * matched against another's request.
 */
const recoveredEstablishmentErrors = (events: readonly TranscriptEvent[]): ReadonlySet<string> => {
  const ordered = [...events].toSorted((left, right) => left.sequence - right.sequence);

  /** The establishment request this error answered, if it answered one at all. */
  const answersEstablishment = (error: TranscriptEvent): boolean =>
    error.requestId !== undefined &&
    ordered.some(
      (candidate) =>
        candidate.requestId === error.requestId &&
        candidate.sequence < error.sequence &&
        ESTABLISHMENT_KINDS.has(candidate.kind) &&
        // Nearest preceding: nothing else reused this id in between.
        !ordered.some(
          (between) =>
            between.requestId === error.requestId &&
            between.sequence > candidate.sequence &&
            between.sequence < error.sequence,
        ),
    );

  /**
   * Evidence the connection carried on: anything after the error that is
   * neither another failure nor merely the next attempt being sent. A request
   * on its own proves only that acpx tried again.
   */
  const connectionContinuedAfter = (sequence: number): boolean =>
    ordered.some(
      (event) =>
        event.sequence > sequence &&
        event.kind !== "jsonrpc_error" &&
        !ESTABLISHMENT_KINDS.has(event.kind),
    );

  return new Set(
    ordered.flatMap((event) =>
      event.kind === "jsonrpc_error" &&
      answersEstablishment(event) &&
      connectionContinuedAfter(event.sequence)
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
