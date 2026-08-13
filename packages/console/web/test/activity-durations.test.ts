import assert from "node:assert/strict";
import test from "node:test";
import { activityDurationMs, activityDurations, formatDuration } from "../src/activity-durations";
import type { TranscriptEvent } from "../src/types";

const event = (overrides: Partial<TranscriptEvent> = {}): TranscriptEvent => ({
  id: "tool:epoch:call-1:1",
  sequence: 1,
  occurredAt: "2026-08-13T12:00:00.000Z",
  kind: "tool_call",
  ...overrides,
});

test("a coalesced activity spans its first envelope through its last", () => {
  const call = event({
    requestId: "call-1",
    sourceEvents: [
      event({ id: "a", occurredAt: "2026-08-13T12:00:00.000Z" }),
      event({ id: "c", occurredAt: "2026-08-13T12:00:00.400Z" }),
      event({ id: "b", occurredAt: "2026-08-13T12:00:00.250Z" }),
    ],
  });
  assert.equal(activityDurationMs(call), 400);
  assert.equal(formatDuration(activityDurationMs(call) ?? 0), "0.4s");
});

test("a single-envelope activity reports no duration rather than a misleading zero", () => {
  assert.equal(activityDurationMs(event()), undefined);
  assert.equal(
    activityDurationMs(event({ sourceEvents: [event({ id: "a" }), event({ id: "b" })] })),
    undefined,
  );
});

test("unparseable timestamps never fabricate a span", () => {
  assert.equal(
    activityDurationMs(
      event({
        sourceEvents: [event({ id: "a", occurredAt: "not-a-time" }), event({ id: "b" })],
      }),
    ),
    undefined,
  );
});

test("durations are keyed the way the runtime derives a tool call id", () => {
  const durations = activityDurations([
    event({
      id: "tool:epoch:call-1:1",
      requestId: "call-1",
      sourceEvents: [
        event({ id: "a", occurredAt: "2026-08-13T12:00:00.000Z" }),
        event({ id: "b", occurredAt: "2026-08-13T12:00:08.000Z" }),
      ],
    }),
    event({
      id: "thought-1",
      kind: "reasoning",
      sourceEvents: [
        event({ id: "c", occurredAt: "2026-08-13T12:00:00.000Z" }),
        event({ id: "d", occurredAt: "2026-08-13T12:00:02.000Z" }),
      ],
    }),
  ]);
  assert.equal(durations.get("call-1"), 8_000);
  assert.equal(durations.get("thought-1"), 2_000);
});

test("durations read as identifiers at every scale", () => {
  assert.equal(formatDuration(120), "0.1s");
  assert.equal(formatDuration(8_000), "8s");
  assert.equal(formatDuration(95_000), "2m");
  assert.equal(formatDuration(5_400_000), "1.5h");
});
