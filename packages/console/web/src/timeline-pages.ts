import { coalesceTranscriptEvents } from "./timeline-projector";
import type { TimelinePage, TranscriptEvent } from "./types";

const rawEvents = (events: readonly TranscriptEvent[]): readonly TranscriptEvent[] =>
  events.flatMap((event) => event.sourceEvents ?? [event]);

const sequenceRange = (
  events: readonly TranscriptEvent[],
): { readonly first: number; readonly last: number } | undefined => {
  const sequences = rawEvents(events).map((event) => event.sequence);
  return sequences.length > 0
    ? { first: Math.min(...sequences), last: Math.max(...sequences) }
    : undefined;
};

const refreshGap = (
  events: readonly TranscriptEvent[],
  hasRecoveryCursor: boolean,
): TimelinePage["continuityIssue"] => {
  const sequences = [...new Set(rawEvents(events).map((event) => event.sequence))].toSorted(
    (left, right) => left - right,
  );
  let before: number | undefined;
  let after: number | undefined;
  for (let index = 1; index < sequences.length; index += 1) {
    const previous = sequences[index - 1];
    const current = sequences[index];
    if (previous !== undefined && current !== undefined && current > previous + 1) {
      before = previous;
      after = current;
    }
  }
  if (before === undefined || after === undefined) {
    return undefined;
  }
  const missing = before + 1 === after - 1 ? `${before + 1}` : `${before + 1}-${after - 1}`;
  return {
    reason: "refresh_gap",
    message: hasRecoveryCursor
      ? `Transcript events ${missing} are not loaded yet. Load earlier to recover this window.`
      : `Transcript events ${missing} are missing and no earlier-page cursor can recover them.`,
  };
};

const epochChangeIssue = (): NonNullable<TimelinePage["continuityIssue"]> => ({
  reason: "epoch_changed",
  message:
    "The transcript epoch changed. The stale browser window was discarded because its cursor is no longer valid; visible history may be incomplete.",
});

/**
 * Whether a durable generation was actually replaced.
 *
 * A session with no ledger reports `epoch: null` until its first event creates
 * one, so every new session passes through `null -> real` on its first turn.
 * That is the ledger being created, not a generation being discarded: the
 * browser held nothing that could be invalidated. Reporting it as lost
 * continuity told operators their history might be incomplete during the most
 * ordinary thing a session does.
 *
 * A real generation replaced by a different one is a genuine discontinuity, and
 * so is a ledger that disappears after having existed.
 */
const epochReplaced = (before: string | null, after: string | null): boolean =>
  before !== null && before !== after;

/** Two loaded pages proven to come from different generations. */
const epochsDiverged = (left: string | null, right: string | null): boolean =>
  left !== null && right !== null && left !== right;

const inheritedEpochIssue = (
  left: TimelinePage,
  right: TimelinePage,
): TimelinePage["continuityIssue"] =>
  left.continuityIssue?.reason === "epoch_changed"
    ? left.continuityIssue
    : right.continuityIssue?.reason === "epoch_changed"
      ? right.continuityIssue
      : undefined;

const continuityIssue = (
  left: TimelinePage,
  right: TimelinePage,
  events: readonly TranscriptEvent[],
  previousCursor: string | undefined,
): TimelinePage["continuityIssue"] =>
  inheritedEpochIssue(left, right) ?? refreshGap(events, previousCursor !== undefined);

const mergedCoverage = (
  left: TimelinePage["coverage"],
  right: TimelinePage["coverage"],
): TimelinePage["coverage"] => {
  if (left === "incomplete" || right === "incomplete") {
    return "incomplete";
  }
  return left === "legacy_retained" || right === "legacy_retained" ? "legacy_retained" : "complete";
};

export const normalizeTimelinePage = (page: TimelinePage): TimelinePage => {
  const events = coalesceTranscriptEvents(page.events);
  return {
    ...page,
    events,
    continuityIssue: page.continuityIssue ?? refreshGap(events, page.previousCursor !== undefined),
  };
};

/**
 * Replace the currently loaded live window while retaining every older page.
 * Coalesced items retain their raw source events, so stable event ids from the
 * refreshed window replace overlaps before chunks and tool updates fold again.
 */
export const mergeRefreshedTimelinePage = (
  current: TimelinePage | null,
  latest: TimelinePage,
): TimelinePage => {
  if (!current) {
    return normalizeTimelinePage(latest);
  }
  const normalizedCurrent = normalizeTimelinePage(current);
  const normalizedLatest = normalizeTimelinePage(latest);
  if (epochReplaced(normalizedCurrent.epoch, normalizedLatest.epoch)) {
    return {
      ...normalizedLatest,
      continuityIssue: epochChangeIssue(),
    };
  }
  const currentRange = sequenceRange(normalizedCurrent.events);
  const latestRange = sequenceRange(normalizedLatest.events);
  const latestStartsAfterCurrent =
    currentRange !== undefined &&
    latestRange !== undefined &&
    latestRange.first > currentRange.last + 1;
  /*
   * With nothing loaded yet — a session whose ledger did not exist a moment ago,
   * which is every session before its first turn — the incoming page holds the
   * only cursor that can reach anything older. Keeping the current `undefined`
   * would strand the events before this window until a full reload.
   */
  const previousCursor =
    currentRange === undefined || latestStartsAfterCurrent
      ? normalizedLatest.previousCursor
      : normalizedCurrent.previousCursor;
  const events = coalesceTranscriptEvents([
    ...normalizedCurrent.events,
    ...normalizedLatest.events,
  ]);
  return {
    ...normalizedLatest,
    epoch: normalizedLatest.epoch,
    events,
    previousCursor,
    coverage: mergedCoverage(normalizedCurrent.coverage, normalizedLatest.coverage),
    gap: normalizedCurrent.gap ?? normalizedLatest.gap,
    continuityIssue: continuityIssue(normalizedCurrent, normalizedLatest, events, previousCursor),
    writeError: normalizedLatest.writeError ?? normalizedCurrent.writeError,
  };
};

export const prependEarlierTimelinePage = (
  current: TimelinePage,
  earlier: TimelinePage,
): TimelinePage => {
  const normalizedCurrent = normalizeTimelinePage(current);
  const normalizedEarlier = normalizeTimelinePage(earlier);
  if (epochsDiverged(normalizedCurrent.epoch, normalizedEarlier.epoch)) {
    return {
      ...normalizedCurrent,
      coverage: mergedCoverage(normalizedCurrent.coverage, normalizedEarlier.coverage),
      gap: normalizedCurrent.gap ?? normalizedEarlier.gap,
      continuityIssue: epochChangeIssue(),
      writeError: normalizedCurrent.writeError ?? normalizedEarlier.writeError,
    };
  }
  const events = coalesceTranscriptEvents([
    ...normalizedEarlier.events,
    ...normalizedCurrent.events,
  ]);
  return {
    ...normalizedEarlier,
    epoch: normalizedCurrent.epoch,
    events,
    // Backward pages cannot decide whether the live head still has legacy
    // import work. Preserve only the current head's continuation state.
    legacyImportPending: normalizedCurrent.legacyImportPending === true ? true : undefined,
    coverage: mergedCoverage(normalizedCurrent.coverage, normalizedEarlier.coverage),
    gap: normalizedEarlier.gap ?? normalizedCurrent.gap,
    continuityIssue: continuityIssue(
      normalizedCurrent,
      normalizedEarlier,
      events,
      normalizedEarlier.previousCursor,
    ),
    writeError: normalizedCurrent.writeError ?? normalizedEarlier.writeError,
  };
};
