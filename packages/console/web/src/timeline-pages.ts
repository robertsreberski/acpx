import { coalesceTranscriptEvents } from "./timeline-projector";
import type { TimelinePage } from "./types";

const legacyCoverage = (
  left: TimelinePage["coverage"],
  right: TimelinePage["coverage"],
): TimelinePage["coverage"] =>
  left === "legacy_retained" || right === "legacy_retained" ? "legacy_retained" : "complete";

export const normalizeTimelinePage = (page: TimelinePage): TimelinePage => ({
  ...page,
  events: coalesceTranscriptEvents(page.events),
});

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
  return {
    ...latest,
    events: coalesceTranscriptEvents([...current.events, ...latest.events]),
    previousCursor: current.previousCursor,
    coverage: legacyCoverage(current.coverage, latest.coverage),
    gap: current.gap ?? latest.gap,
    writeError: latest.writeError ?? current.writeError,
  };
};

export const prependEarlierTimelinePage = (
  current: TimelinePage,
  earlier: TimelinePage,
): TimelinePage => ({
  ...earlier,
  events: coalesceTranscriptEvents([...earlier.events, ...current.events]),
  coverage: legacyCoverage(current.coverage, earlier.coverage),
  gap: earlier.gap ?? current.gap,
  writeError: current.writeError ?? earlier.writeError,
});
