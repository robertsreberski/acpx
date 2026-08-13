import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { queueOwnerRuntimeTestInternals } from "../src/cli/session/queue-owner-runtime.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import {
  appendSessionTimelineLifecycleEvent,
  listSessionTimelinePage,
} from "../src/session/timeline.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

test("queued cancellation appends a durable terminal lifecycle event", async () => {
  await withTempHome("acpx-queue-owner-runtime-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const initial = makeSessionRecord({
      acpxRecordId: "session-queued-cancel",
      acpSessionId: "provider-queued-cancel",
      agentCommand: "node ./test/mock-agent.js",
      cwd,
    });
    await writeSessionRecordFile(homeDir, initial);
    const record = await resolveSessionRecord(initial.acpxRecordId);
    await appendSessionTimelineLifecycleEvent(
      record,
      { type: "turn_submitted" },
      { turnId: "turn-queued", requestId: "turn-queued" },
    );

    await queueOwnerRuntimeTestInternals.cancelQueuedTimelineTurn(
      initial.acpxRecordId,
      "turn-queued",
    );

    const timeline = await listSessionTimelinePage(initial.acpxRecordId, { limit: 20 });
    assert.deepEqual(
      timeline.items.flatMap((item) =>
        "seq" in item && item.payload.kind === "lifecycle"
          ? [[item.turn_id, item.request_id, item.payload.event.type]]
          : [],
      ),
      [
        ["turn-queued", "turn-queued", "turn_submitted"],
        ["turn-queued", "turn-queued", "turn_cancelled"],
      ],
    );
  });
});
