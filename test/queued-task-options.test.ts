import assert from "node:assert/strict";
import test from "node:test";
import { sessionRuntimeTestInternals } from "../src/cli/session/runtime.js";

const { mergeQueuedTaskSessionPreferences } = sessionRuntimeTestInternals;

test("queued tasks inherit owner effort as the prompt-time request", () => {
  const preferences = mergeQueuedTaskSessionPreferences(
    { model: "task-model" },
    { model: "owner-model", effort: "high" },
  );

  assert.deepEqual(preferences.sessionOptions, {
    model: "task-model",
    effort: "high",
  });
  assert.equal(preferences.requestedEffort, "high");
});
