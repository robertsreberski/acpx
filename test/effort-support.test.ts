import assert from "node:assert/strict";
import test from "node:test";
import type { AcpClient } from "../src/acp/client.js";
import {
  assertRequestedEffortSupported,
  effortStateFromConfigOptions,
  isRequestedEffortUnsupportedError,
  REQUESTED_EFFORT_UNSUPPORTED_ERROR_CODE,
  RequestedEffortUnsupportedError,
} from "../src/acp/effort-support.js";
import { applyRequestedModelAndEffortIfAdvertised } from "../src/session/model-application.js";

function effortOption(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "reasoning_effort",
    name: "Reasoning Effort",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
    ...overrides,
  };
}

test("effort discovery prefers the ACP thought-level category", () => {
  const state = effortStateFromConfigOptions([
    effortOption({ id: "effort", category: undefined }),
    effortOption({ id: "custom_thinking" }),
  ]);

  assert.deepEqual(state, {
    configId: "custom_thinking",
    currentEffort: "medium",
    availableEfforts: [
      { effort: "low", name: "Low" },
      { effort: "medium", name: "Medium" },
      { effort: "high", name: "High" },
    ],
  });
});

test("effort discovery falls back to portable config ids when category is absent", () => {
  const state = effortStateFromConfigOptions([
    effortOption({
      category: undefined,
      options: [
        {
          group: "standard",
          name: "Standard",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
    }),
  ]);

  assert.deepEqual(state?.availableEfforts, [
    { effort: "low", name: "Low" },
    { effort: "high", name: "High" },
  ]);
});

test("effort discovery recognizes category-less thinking aliases", () => {
  for (const id of ["thinking", "thinking_level"]) {
    const state = effortStateFromConfigOptions([effortOption({ id, category: undefined })]);
    assert.equal(state?.configId, id);
  }
});

test("effort validation reports model-specific advertised values", () => {
  assert.throws(
    () =>
      assertRequestedEffortSupported({
        requestedEffort: "xhigh",
        configOptions: [effortOption()],
        modelId: "smart-model",
      }),
    (error: unknown) => {
      assert(error instanceof RequestedEffortUnsupportedError);
      assert.equal(error.code, REQUESTED_EFFORT_UNSUPPORTED_ERROR_CODE);
      assert.equal(error.reason, "unadvertised-effort");
      assert.equal(isRequestedEffortUnsupportedError(error), true);
      assert.match(error.message, /model "smart-model"/);
      assert.match(error.message, /Available efforts: low, medium, high/);
      return true;
    },
  );
});

test("effort discovery uses the first usable categorized selector in ACP order", () => {
  const state = effortStateFromConfigOptions([
    effortOption({ id: "invalid-first", type: "boolean", currentValue: true, options: undefined }),
    effortOption({ id: "preferred" }),
    effortOption({ id: "later" }),
  ]);

  assert.equal(state?.configId, "preferred");
});

test("effort validation distinguishes missing and invalid capabilities", () => {
  const scenarios = [
    {
      configOptions: [],
      reason: "missing-capability",
      message: /did not advertise a thought-level session config option/,
    },
    {
      configOptions: [effortOption({ type: "boolean", currentValue: true, options: undefined })],
      reason: "invalid-capability",
      message: /not a usable select option/,
    },
  ] as const;

  for (const scenario of scenarios) {
    assert.throws(
      () =>
        assertRequestedEffortSupported({
          requestedEffort: "high",
          configOptions: scenario.configOptions,
          modelId: "default-model",
        }),
      (error: unknown) => {
        assert(error instanceof RequestedEffortUnsupportedError);
        assert.equal(error.reason, scenario.reason);
        assert.match(error.message, scenario.message);
        return true;
      },
    );
  }
});

test("effort unsupported predicate accepts serialized errors and rejects unrelated values", () => {
  assert.equal(
    isRequestedEffortUnsupportedError({
      name: "RequestedEffortUnsupportedError",
      code: REQUESTED_EFFORT_UNSUPPORTED_ERROR_CODE,
      reason: "missing-capability",
    }),
    true,
  );
  assert.equal(isRequestedEffortUnsupportedError(new Error("effort unsupported")), false);
  assert.equal(
    isRequestedEffortUnsupportedError({
      name: "RequestedEffortUnsupportedError",
      code: REQUESTED_EFFORT_UNSUPPORTED_ERROR_CODE,
      reason: "unknown",
    }),
    false,
  );
});

test("combined model and effort rejects legacy model switching before mutation", async () => {
  let setModelCalls = 0;
  const client = {
    setSessionModel: () => {
      setModelCalls += 1;
      return Promise.resolve(undefined);
    },
  } as unknown as AcpClient;

  await assert.rejects(
    applyRequestedModelAndEffortIfAdvertised({
      client,
      sessionId: "session-1",
      requestedModel: "new-model",
      requestedEffort: "high",
      models: {
        currentModelId: "old-model",
        availableModels: [
          { modelId: "old-model", name: "Old" },
          { modelId: "new-model", name: "New" },
        ],
      },
      configOptions: [effortOption()],
    }),
    (error: unknown) => {
      assert(error instanceof RequestedEffortUnsupportedError);
      assert.equal(error.reason, "invalid-capability");
      assert.match(error.message, /only exposes legacy model switching/);
      return true;
    },
  );
  assert.equal(setModelCalls, 0);
});
