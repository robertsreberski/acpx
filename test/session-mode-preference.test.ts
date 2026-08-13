import assert from "node:assert/strict";
import test from "node:test";
import {
  getDesiredConfigOptions,
  getDesiredEffort,
  getDesiredModeId,
  normalizeModeId,
  reconcileDesiredEffortForModelChange,
  setDesiredConfigOption,
  setDesiredEffort,
  setDesiredModeId,
  setDesiredModelId,
} from "../src/session/mode-preference.js";
import type { SessionRecord } from "../src/types.js";

test("normalizeModeId trims valid values and drops blanks", () => {
  assert.equal(normalizeModeId(" plan "), "plan");
  assert.equal(normalizeModeId(""), undefined);
  assert.equal(normalizeModeId("   "), undefined);
  assert.equal(normalizeModeId(undefined), undefined);
});

test("getDesiredModeId reads normalized desired_mode_id", () => {
  assert.equal(getDesiredModeId({ desired_mode_id: " auto " }), "auto");
  assert.equal(getDesiredModeId({ desired_mode_id: "   " }), undefined);
  assert.equal(getDesiredModeId(undefined), undefined);
});

test("setDesiredModeId creates and clears acpx mode preference state", () => {
  const record = makeSessionRecord();

  setDesiredModeId(record, " plan ");
  assert.deepEqual(record.acpx, {
    desired_mode_id: "plan",
  });

  setDesiredModeId(record, "   ");
  assert.deepEqual(record.acpx, {});

  setDesiredModeId(record, undefined);
  assert.deepEqual(record.acpx, {});
});

test("setDesiredConfigOption persists non-mode config option preferences", () => {
  const record = makeSessionRecord();

  setDesiredConfigOption(record, " reasoning_effort ", "high");
  setDesiredConfigOption(record, "mode", "plan");
  setDesiredConfigOption(record, "model", "gpt-5.4");

  assert.deepEqual(record.acpx, {
    desired_config_options: {
      reasoning_effort: "high",
    },
  });
  assert.deepEqual(getDesiredConfigOptions(record.acpx), {
    reasoning_effort: "high",
  });

  setDesiredConfigOption(record, "reasoning_effort", undefined);
  assert.deepEqual(record.acpx, {});
});

test("setDesiredModelId preserves session env when clearing model", () => {
  const record = makeSessionRecord();
  record.acpx = {
    session_options: {
      model: "claude-sonnet-4-6",
      env: {
        GIT_AUTHOR_EMAIL: "agent@example.local",
      },
    },
  };

  setDesiredModelId(record, undefined);

  assert.deepEqual(record.acpx, {
    session_options: {
      env: {
        GIT_AUTHOR_EMAIL: "agent@example.local",
      },
    },
  });
});

test("setDesiredEffort persists the portable value and adapter config id", () => {
  const record = makeSessionRecord();

  setDesiredEffort(record, " high ", "reasoning_effort");

  assert.equal(getDesiredEffort(record.acpx), "high");
  assert.deepEqual(record.acpx, {
    session_options: { effort: "high" },
    desired_config_options: { reasoning_effort: "high" },
  });

  setDesiredEffort(record, undefined, "reasoning_effort");
  assert.deepEqual(record.acpx, {});
});

test("model changes clear a saved effort the new model does not advertise", () => {
  const previousState = {
    session_options: { model: "smart-model", effort: "xhigh" },
    desired_config_options: { reasoning_effort: "xhigh", other: "kept" },
    config_options: [effortOption("reasoning_effort", "xhigh", ["high", "xhigh"])],
  };
  const nextState = {
    ...previousState,
    session_options: { ...previousState.session_options, model: "fast-model" },
    config_options: [effortOption("reasoning_effort", "medium", ["low", "medium"])],
  };

  const result = reconcileDesiredEffortForModelChange(previousState, nextState);

  assert.equal(result.selection, undefined);
  assert.deepEqual(result.state.session_options, { model: "fast-model" });
  assert.deepEqual(result.state.desired_config_options, { other: "kept" });
});

test("model changes retain and rebase a compatible saved effort", () => {
  const previousState = {
    session_options: { model: "old-model", effort: "xhigh" },
    desired_config_options: { old_effort: "xhigh" },
    config_options: [effortOption("old_effort", "xhigh", ["high", "xhigh"])],
  };
  const nextState = {
    ...previousState,
    session_options: { ...previousState.session_options, model: "new-model" },
    config_options: [effortOption("new_effort", "high", ["high", "xhigh"])],
  };

  const result = reconcileDesiredEffortForModelChange(previousState, nextState);

  assert.deepEqual(result.selection, { configId: "new_effort", effort: "xhigh" });
  assert.deepEqual(result.state.desired_config_options, { new_effort: "xhigh" });
  assert.equal(result.state.session_options?.effort, "xhigh");
});

function effortOption(id: string, currentValue: string, values: string[]) {
  return {
    id,
    name: "Reasoning Effort",
    category: "thought_level",
    type: "select" as const,
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  };
}

function makeSessionRecord(): SessionRecord {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: "mode-record",
    acpSessionId: "mode-session",
    agentCommand: "agent",
    cwd: "/tmp/acpx",
    createdAt: timestamp,
    lastUsedAt: timestamp,
    lastSeq: 0,
    eventLog: {
      active_path: ".stream.ndjson",
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: timestamp,
      last_write_error: null,
    },
    closed: false,
    title: null,
    messages: [],
    updated_at: timestamp,
    cumulative_token_usage: {},
    request_token_usage: {},
  };
}
