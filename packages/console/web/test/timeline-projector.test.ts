import assert from "node:assert/strict";
import test from "node:test";
import { syntheticPendingInteractionEvents } from "../src/runtime";
import {
  coalesceTranscriptEvents,
  firstInteractionEventIds,
  normalizeHistoricalRunningEvent,
  projectTimelineEvent,
  timelineActivityToolName,
  timelineEventIsRunning,
  type WireTimelineEvent,
} from "../src/timeline-projector";
import type { PendingInteraction } from "../src/types";

const wire = (
  seq: number,
  payload: unknown,
  extra: Partial<WireTimelineEvent> = {},
): WireTimelineEvent => ({
  schema: "acpx.session_event.v1",
  epoch: "epoch-1",
  seq,
  captured_at: `2026-08-12T10:00:0${seq}.000Z`,
  direction: "inbound",
  turn_id: "turn-1",
  payload,
  ...extra,
});

const interaction = (id: string, state: PendingInteraction["state"]): PendingInteraction => ({
  id,
  sessionId: "session-1",
  kind: "permission",
  state,
  createdAt: "2026-08-12T10:00:00.000Z",
  title: `Permission ${id}`,
});

test("only synthesizes still-pending interactions missing from the durable timeline", () => {
  const events = syntheticPendingInteractionEvents(
    [interaction("pending-new", "pending"), interaction("answered-old", "answered")],
    new Set(["covered"]),
  );
  assert.deepEqual(
    events.map((event) => [event.requestId, event.status]),
    [["pending-new", "pending"]],
  );
  assert.deepEqual(
    syntheticPendingInteractionEvents([interaction("covered", "pending")], new Set(["covered"])),
    [],
  );
});

test("preserves tool identity and only streams activity from the active turn", () => {
  const tool = projectTimelineEvent(
    wire(
      1,
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        kind: "execute",
        status: "in_progress",
      }),
    ),
  );
  assert.equal(timelineActivityToolName(tool), "execute");
  assert.equal(timelineActivityToolName(tool, "permission-1"), "acpx:interaction:permission-1");
  assert.equal(timelineEventIsRunning(tool), true);
  const chunk = projectTimelineEvent(
    wire(2, update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } })),
  );
  assert.equal(normalizeHistoricalRunningEvent(chunk, "turn-1").status, "streaming");
  assert.equal(normalizeHistoricalRunningEvent(chunk, "turn-2").status, "complete");
  assert.equal(normalizeHistoricalRunningEvent(tool, "turn-1").status, "in_progress");
  assert.equal(normalizeHistoricalRunningEvent(tool, "turn-2").status, "complete");
  assert.equal(
    normalizeHistoricalRunningEvent({ ...tool, status: "pending" }, undefined).status,
    "complete",
  );
});

const update = (value: unknown): unknown => ({
  kind: "acp",
  message: { jsonrpc: "2.0", method: "session/update", params: { update: value } },
});

test("projects prompt blocks and coalesces assistant message and thought chunks", () => {
  const events = [
    projectTimelineEvent(
      wire(
        1,
        {
          kind: "acp",
          message: {
            jsonrpc: "2.0",
            id: 1,
            method: "session/prompt",
            params: {
              prompt: [
                { type: "text", text: "Fix " },
                { type: "text", text: "checkout" },
              ],
            },
          },
        },
        { direction: "outbound" },
      ),
    ),
    projectTimelineEvent(
      wire(
        2,
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } }),
      ),
    ),
    projectTimelineEvent(
      wire(
        3,
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } }),
      ),
    ),
    projectTimelineEvent(
      wire(
        4,
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Check" } }),
      ),
    ),
    projectTimelineEvent(
      wire(
        5,
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " tests" } }),
      ),
    ),
  ];
  const projected = coalesceTranscriptEvents(events);
  assert.equal(projected.length, 3);
  assert.deepEqual(
    projected.map((event) => [event.kind, event.role, event.text]),
    [
      ["message", "user", "Fix \ncheckout"],
      ["message", "assistant", "Done."],
      ["reasoning", "assistant", "Check tests"],
    ],
  );
});

test("binds event identity and stream coalescing to the timeline epoch", () => {
  const first = projectTimelineEvent(
    wire(
      1,
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old" } }),
      { epoch: "epoch-old" },
    ),
  );
  const reset = projectTimelineEvent(
    wire(
      1,
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new" } }),
      { epoch: "epoch-new" },
    ),
  );

  assert.equal(first.id, "event:epoch-old:1");
  assert.equal(reset.id, "event:epoch-new:1");
  assert.deepEqual(
    coalesceTranscriptEvents([first, reset]).map((item) => item.text),
    ["old", "new"],
  );
});

test("merges tool updates by call id without losing surrounding chronology", () => {
  const start = projectTimelineEvent(
    wire(
      1,
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Run tests",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "pnpm test" },
      }),
    ),
  );
  const finish = projectTimelineEvent(
    wire(
      2,
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        rawOutput: { exitCode: 0 },
      }),
    ),
  );
  const projected = coalesceTranscriptEvents([start, finish]);
  assert.equal(projected.length, 1);
  assert.equal(projected[0]?.title, "Run tests");
  assert.equal(projected[0]?.status, "completed");
  assert.deepEqual(projected[0]?.input, { command: "pnpm test" });
  assert.deepEqual(projected[0]?.output, { exitCode: 0 });
});

test("keeps unknown ACP envelopes available as raw activity", () => {
  const projected = projectTimelineEvent(
    wire(1, {
      kind: "acp",
      message: { jsonrpc: "2.0", method: "extension/future", params: { opaque: true } },
    }),
  );
  assert.equal(projected.kind, "extension/future");
  assert.equal(projected.title, "extension/future");
  assert.deepEqual(projected.input, { opaque: true });
  assert.deepEqual(projected.payload, {
    kind: "acp",
    message: { jsonrpc: "2.0", method: "extension/future", params: { opaque: true } },
  });
});

test("projects lifecycle events without presenting them as chat text", () => {
  const projected = projectTimelineEvent(
    wire(
      1,
      {
        kind: "lifecycle",
        event: { type: "turn_completed", stop_reason: "end_turn" },
      },
      { direction: "internal" },
    ),
  );
  assert.equal(projected.kind, "lifecycle");
  assert.equal(projected.title, "Turn completed");
  assert.equal(projected.status, "completed");
  assert.equal(projected.role, "assistant");
});

test("binds an interaction card only to the request's first chronological event", () => {
  const events = [
    {
      ...projectTimelineEvent(
        wire(
          3,
          { kind: "acp", message: { method: "request/settled" } },
          { request_id: "request-1" },
        ),
      ),
      id: "answered",
    },
    {
      ...projectTimelineEvent(
        wire(
          1,
          { kind: "acp", message: { method: "session/request_permission" } },
          { request_id: "request-1" },
        ),
      ),
      id: "created",
    },
    {
      ...projectTimelineEvent(
        wire(
          2,
          { kind: "acp", message: { method: "session/request_permission" } },
          { request_id: "request-2" },
        ),
      ),
      id: "second",
    },
  ];
  assert.deepEqual(
    [...firstInteractionEventIds(events)],
    [
      ["request-1", "created"],
      ["request-2", "second"],
    ],
  );
});
