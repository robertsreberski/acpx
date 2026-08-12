import assert from "node:assert/strict";
import test from "node:test";
import { mergeRefreshedTimelinePage } from "../src/timeline-pages";
import { coalesceTranscriptEvents } from "../src/timeline-projector";
import type { TimelinePage, TranscriptEvent } from "../src/types";

const event = (id: string, sequence: number, text: string, turnId = "turn-1"): TranscriptEvent => ({
  id,
  sequence,
  occurredAt: `2026-08-12T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  kind: "message",
  role: "assistant",
  turnId,
  text,
  status: "streaming",
});

test("a live refresh replaces its window but preserves loaded history and its oldest cursor", () => {
  const current: TimelinePage = {
    events: coalesceTranscriptEvents([
      event("old", 1, "Earlier", "turn-old"),
      event("stale-100", 100, "stale "),
      event("stale-101", 101, "reply"),
    ]),
    previousCursor: "oldest-cursor",
    coverage: "legacy_retained",
    gap: { reason: "oldest retained gap" },
  };
  const latest: TimelinePage = {
    events: [event("stale-100", 100, "fresh "), event("stale-101", 101, "reply")],
    previousCursor: "latest-window-cursor",
    coverage: "complete",
    gap: { reason: "new gap" },
  };

  const merged = mergeRefreshedTimelinePage(current, latest);
  assert.equal(merged.previousCursor, "oldest-cursor");
  assert.equal(merged.coverage, "legacy_retained");
  assert.deepEqual(merged.gap, { reason: "oldest retained gap" });
  assert.deepEqual(
    merged.events.map(({ id, text, sequence, sourceEvents }) => ({
      id,
      text,
      sequence,
      sourceIds: sourceEvents?.map((event) => event.id),
    })),
    [
      { id: "old", text: "Earlier", sequence: 1, sourceIds: undefined },
      {
        id: "stale-100",
        text: "fresh reply",
        sequence: 100,
        sourceIds: ["stale-100", "stale-101"],
      },
    ],
  );
});
