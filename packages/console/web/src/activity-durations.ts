import type { TranscriptEvent } from "./types";

/**
 * Elapsed time for a projected activity, taken from the envelopes that were
 * coalesced into it: a tool call spans its `tool_call` envelope through its last
 * `tool_call_update`, and a thought spans its chunk stream.
 *
 * A single-envelope activity has no measurable span, so it reports nothing
 * rather than a misleading `0.0s`.
 */
export const activityDurationMs = (event: TranscriptEvent): number | undefined => {
  const sources = event.sourceEvents ?? [event];
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const source of sources) {
    const at = Date.parse(source.occurredAt);
    if (!Number.isFinite(at)) {
      continue;
    }
    earliest = Math.min(earliest, at);
    latest = Math.max(latest, at);
  }
  const span = latest - earliest;
  return Number.isFinite(span) && span > 0 ? span : undefined;
};

/** Keyed the way `convertTimelineMessage` derives `toolCallId`. */
export const activityDurations = (
  events: readonly TranscriptEvent[],
): ReadonlyMap<string, number> => {
  const durations = new Map<string, number>();
  for (const event of events) {
    const span = activityDurationMs(event);
    if (span !== undefined) {
      durations.set(event.requestId ?? event.id, span);
    }
  }
  return durations;
};

export const formatDuration = (ms: number): string => {
  if (ms < 1_000) {
    return `${(ms / 1_000).toFixed(1)}s`;
  }
  if (ms < 60_000) {
    return `${Math.round(ms / 1_000)}s`;
  }
  if (ms < 3_600_000) {
    return `${Math.round(ms / 60_000)}m`;
  }
  return `${Math.round(ms / 360_000) / 10}h`;
};
