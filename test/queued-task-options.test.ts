import assert from "node:assert/strict";
import test from "node:test";
import { sessionRuntimeTestInternals } from "../src/cli/session/runtime.js";

const { mergeQueuedTaskSessionPreferences, oneShotInitialDrainIdleMs } =
  sessionRuntimeTestInternals;

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

test("one-shot Codex turns retain the full late-compaction observation horizon", () => {
  assert.equal(
    oneShotInitialDrainIdleMs({
      agentCommand: "npx -y @agentclientprotocol/codex-acp@^1.1.5",
    }),
    undefined,
  );
  assert.equal(
    oneShotInitialDrainIdleMs({
      agentCommand: "ignored structured identity",
      agentArgv: ["npx", "-y", "@agentclientprotocol/codex-acp@^1.1.5"],
    }),
    undefined,
  );
  assert.equal(
    oneShotInitialDrainIdleMs({
      agentCommand: "npx -y @agentclientprotocol/claude-agent-acp@^0.66.0",
    }),
    100,
  );
});
