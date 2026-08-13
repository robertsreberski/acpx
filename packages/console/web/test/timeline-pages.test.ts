import assert from "node:assert/strict";
import test from "node:test";
import { mergeRefreshedTimelinePage, prependEarlierTimelinePage } from "../src/timeline-pages";
import { coalesceTranscriptEvents } from "../src/timeline-projector";
import type { TimelinePage, TranscriptEvent } from "../src/types";

const event = (
  epoch: string,
  sequence: number,
  text = String(sequence),
  turnId = `turn-${sequence}`,
): TranscriptEvent => ({
  id: `event:${epoch}:${sequence}`,
  epoch,
  sequence,
  occurredAt: `2026-08-12T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  kind: "message",
  role: "assistant",
  turnId,
  text,
  status: "streaming",
});

const events = (epoch: string, from: number, through: number): readonly TranscriptEvent[] =>
  Array.from({ length: through - from + 1 }, (_, index) => event(epoch, from + index));

test("a live refresh replaces its window but preserves loaded history and its oldest cursor", () => {
  const current: TimelinePage = {
    events: coalesceTranscriptEvents([
      event("epoch-1", 1, "Earlier", "turn-old"),
      event("epoch-1", 100, "stale ", "turn-1"),
      event("epoch-1", 101, "reply", "turn-1"),
    ]),
    epoch: "epoch-1",
    previousCursor: "oldest-cursor",
    coverage: "legacy_retained",
    gap: { reason: "oldest retained gap" },
    writeError: "old warning",
  };
  const latest: TimelinePage = {
    events: [event("epoch-1", 100, "fresh ", "turn-1"), event("epoch-1", 101, "reply", "turn-1")],
    epoch: "epoch-1",
    previousCursor: "latest-window-cursor",
    coverage: "complete",
    legacyImportPending: true,
    gap: { reason: "new gap" },
    writeError: "latest warning",
  };

  const merged = mergeRefreshedTimelinePage(current, latest);
  assert.equal(merged.previousCursor, "oldest-cursor");
  assert.equal(merged.coverage, "legacy_retained");
  assert.deepEqual(merged.gap, { reason: "oldest retained gap" });
  assert.equal(merged.writeError, "latest warning");
  assert.equal(merged.legacyImportPending, true);
  assert.deepEqual(
    merged.events.map(({ id, text, sequence, sourceEvents }) => ({
      id,
      text,
      sequence,
      sourceIds: sourceEvents?.map((event) => event.id),
    })),
    [
      { id: "event:epoch-1:1", text: "Earlier", sequence: 1, sourceIds: undefined },
      {
        id: "event:epoch-1:100",
        text: "fresh reply",
        sequence: 100,
        sourceIds: ["event:epoch-1:100", "event:epoch-1:101"],
      },
    ],
  );
});

test("page merging never erases incomplete durable-history coverage", () => {
  const corrupt: TimelinePage = {
    epoch: "epoch-1",
    events: [],
    coverage: "incomplete",
    gap: { reason: "corrupt", message: "A corrupt epoch was isolated." },
  };
  const refreshed = mergeRefreshedTimelinePage(corrupt, {
    epoch: "epoch-1",
    events: [],
    coverage: "complete",
  });
  assert.equal(refreshed.coverage, "incomplete");
  assert.equal(refreshed.gap?.reason, "corrupt");
});

test("a non-overlapping live window retains the cursor that can bridge every missing event", () => {
  const current: TimelinePage = {
    epoch: "epoch-1",
    events: events("epoch-1", 21, 100),
    previousCursor: "before-21",
    coverage: "complete",
  };
  const latest: TimelinePage = {
    epoch: "epoch-1",
    events: events("epoch-1", 121, 200),
    previousCursor: "before-121",
    coverage: "complete",
  };

  const disconnected = mergeRefreshedTimelinePage(current, latest);
  assert.equal(disconnected.previousCursor, "before-121");
  assert.equal(disconnected.continuityIssue?.reason, "refresh_gap");
  assert.equal(disconnected.events.length, 160);

  const bridged = prependEarlierTimelinePage(disconnected, {
    epoch: "epoch-1",
    events: events("epoch-1", 41, 120),
    previousCursor: "before-41",
    coverage: "complete",
  });
  assert.equal(bridged.previousCursor, "before-41");
  assert.equal(bridged.continuityIssue, undefined);
  assert.deepEqual(
    bridged.events.map((item) => item.sequence),
    Array.from({ length: 180 }, (_, index) => index + 21),
  );
});

test("an overlapping live window preserves the oldest loaded cursor without duplicating events", () => {
  const merged = mergeRefreshedTimelinePage(
    {
      epoch: "epoch-1",
      events: events("epoch-1", 21, 100),
      previousCursor: "before-21",
      coverage: "complete",
    },
    {
      epoch: "epoch-1",
      events: events("epoch-1", 91, 170),
      previousCursor: "before-91",
      coverage: "complete",
    },
  );

  assert.equal(merged.previousCursor, "before-21");
  assert.equal(merged.continuityIssue, undefined);
  assert.deepEqual(
    merged.events.map((item) => item.sequence),
    Array.from({ length: 150 }, (_, index) => index + 21),
  );
});

test("an epoch reset discards the stale projection and reports the lost continuity", () => {
  const reset = mergeRefreshedTimelinePage(
    {
      epoch: "epoch-old",
      events: events("epoch-old", 1, 80),
      previousCursor: "old-cursor",
      coverage: "complete",
    },
    {
      epoch: "epoch-new",
      events: events("epoch-new", 1, 20),
      previousCursor: "new-cursor",
      coverage: "complete",
    },
  );

  assert.equal(reset.epoch, "epoch-new");
  assert.equal(reset.previousCursor, "new-cursor");
  assert.equal(reset.continuityIssue?.reason, "epoch_changed");
  assert.deepEqual(
    reset.events.map((item) => item.id),
    events("epoch-new", 1, 20).map((item) => item.id),
  );
});

test("an epoch reset does not carry stale durable-history diagnostics into the new epoch", () => {
  const reset = mergeRefreshedTimelinePage(
    {
      epoch: "epoch-corrupt",
      events: events("epoch-corrupt", 1, 80),
      coverage: "incomplete",
      gap: { reason: "corrupt", message: "The old epoch was corrupt." },
      writeError: "The old epoch failed its last write.",
    },
    {
      epoch: "epoch-clean",
      events: events("epoch-clean", 1, 20),
      coverage: "complete",
    },
  );

  assert.equal(reset.coverage, "complete");
  assert.equal(reset.gap, undefined);
  assert.equal(reset.writeError, undefined);
  assert.equal(reset.continuityIssue?.reason, "epoch_changed");
});

test("an authoritative empty replacement epoch clears stale transcript events", () => {
  const reset = mergeRefreshedTimelinePage(
    {
      epoch: "epoch-old",
      events: events("epoch-old", 1, 20),
      previousCursor: "old-cursor",
      coverage: "complete",
    },
    {
      epoch: "epoch-new",
      events: [],
      coverage: "incomplete",
      gap: { reason: "corrupt", message: "A corrupt epoch was isolated." },
    },
  );

  assert.equal(reset.epoch, "epoch-new");
  assert.equal(reset.previousCursor, undefined);
  assert.deepEqual(reset.events, []);
  assert.equal(reset.gap?.reason, "corrupt");
  assert.equal(reset.continuityIssue?.reason, "epoch_changed");
});
