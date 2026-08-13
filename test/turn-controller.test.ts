import assert from "node:assert/strict";
import test from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import {
  QueueOwnerTurnController,
  type QueueOwnerActiveSessionController,
} from "../src/cli/queue/owner-turn-controller.js";

test("QueueOwnerTurnController tracks explicit lifecycle states", async () => {
  const controller = createQueueOwnerTurnController();
  assert.equal(controller.lifecycleState, "idle");

  await controller.beginTurn();
  assert.equal(controller.lifecycleState, "starting");

  controller.markPromptActive();
  assert.equal(controller.lifecycleState, "active");

  controller.endTurn();
  assert.equal(controller.lifecycleState, "idle");

  controller.beginClosing();
  assert.equal(controller.lifecycleState, "closing");
  const cancelled = await controller.requestCancel();
  assert.equal(cancelled, false);
});

test("QueueOwnerTurnController cancels immediately for active prompts", async () => {
  const controller = createQueueOwnerTurnController();
  let cancelCalls = 0;

  await controller.beginTurn();
  controller.setActiveController(
    makeActiveController({
      hasActivePrompt: () => true,
      requestCancelActivePrompt: async () => {
        cancelCalls += 1;
        return true;
      },
    }),
  );
  controller.markPromptActive();

  const cancelled = await controller.requestCancel();
  assert.equal(cancelled, true);
  assert.equal(cancelCalls, 1);
  assert.equal(controller.hasPendingCancel, false);
});

test("QueueOwnerTurnController defers cancel while turn is starting", async () => {
  const controller = createQueueOwnerTurnController();
  let promptActive = false;
  let cancelCalls = 0;

  await controller.beginTurn();
  controller.setActiveController(
    makeActiveController({
      hasActivePrompt: () => promptActive,
      requestCancelActivePrompt: async () => {
        cancelCalls += 1;
        return promptActive;
      },
    }),
  );

  const accepted = await controller.requestCancel();
  assert.equal(accepted, true);
  assert.equal(cancelCalls, 0);
  assert.equal(controller.hasPendingCancel, true);

  const beforeActive = await controller.applyPendingCancel();
  assert.equal(beforeActive, false);
  assert.equal(cancelCalls, 0);
  assert.equal(controller.hasPendingCancel, true);

  promptActive = true;
  controller.markPromptActive();
  const afterActive = await controller.applyPendingCancel();
  assert.equal(afterActive, true);
  assert.equal(cancelCalls, 1);
  assert.equal(controller.hasPendingCancel, false);
});

test("QueueOwnerTurnController routes setSessionMode through active controller", async () => {
  let activeCalls = 0;
  let fallbackCalls = 0;
  const observedTimeouts: Array<number | undefined> = [];
  const fallbackTimeouts: Array<number | undefined> = [];

  const controller = createQueueOwnerTurnController({
    withTimeout: async (run, timeoutMs) => {
      observedTimeouts.push(timeoutMs);
      return await run();
    },
    setSessionModeFallback: async (_modeId, timeoutMs) => {
      fallbackCalls += 1;
      fallbackTimeouts.push(timeoutMs);
    },
  });

  controller.setActiveController(
    makeActiveController({
      setSessionMode: async () => {
        activeCalls += 1;
      },
    }),
  );

  await controller.setSessionMode("plan", 1250);
  assert.equal(activeCalls, 1);
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(observedTimeouts, [1250]);
  assert.deepEqual(fallbackTimeouts, []);
});

test("QueueOwnerTurnController routes setSessionModel through active controller", async () => {
  let activeCalls = 0;
  let fallbackCalls = 0;
  const observedTimeouts: Array<number | undefined> = [];
  const fallbackTimeouts: Array<number | undefined> = [];

  const controller = createQueueOwnerTurnController({
    withTimeout: async (run, timeoutMs) => {
      observedTimeouts.push(timeoutMs);
      return await run();
    },
    setSessionModelFallback: async (_modelId, timeoutMs) => {
      fallbackCalls += 1;
      fallbackTimeouts.push(timeoutMs);
      return { configOptions: [] };
    },
  });

  const reportedResponse: SetSessionConfigOptionResponse = {
    configOptions: [
      {
        id: "model",
        name: "Model",
        type: "select",
        options: [{ value: "fast-model", name: "Fast" }],
        currentValue: "fast-model",
      },
    ],
  };
  controller.setActiveController(
    makeActiveController({
      setSessionModel: async () => {
        activeCalls += 1;
        return reportedResponse;
      },
    }),
  );

  const response = await controller.setSessionModel("gpt-5.4", 1500);
  assert.equal(activeCalls, 1);
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(observedTimeouts, [1500]);
  assert.deepEqual(fallbackTimeouts, []);
  assert.equal(response, reportedResponse);
});

test("QueueOwnerTurnController routes setSessionConfigOption through fallback when inactive", async () => {
  let fallbackCalls = 0;
  const fallbackTimeouts: Array<number | undefined> = [];

  const controller = createQueueOwnerTurnController({
    setSessionConfigOptionFallback: async (_configId, _value, timeoutMs) => {
      fallbackCalls += 1;
      fallbackTimeouts.push(timeoutMs);
      return { configOptions: [] };
    },
  });

  const response = await controller.setSessionConfigOption("approval_policy", "strict", 2300);
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(fallbackTimeouts, [2300]);
  assert.deepEqual(response, { configOptions: [] });
});

test("QueueOwnerTurnController waits for turn setup before routing individual controls", async () => {
  const activeCalls: string[] = [];
  let fallbackCalls = 0;
  const controller = createQueueOwnerTurnController({
    setSessionModeFallback: async () => {
      fallbackCalls += 1;
    },
    setSessionModelFallback: async () => {
      fallbackCalls += 1;
      return undefined;
    },
    setSessionConfigOptionFallback: async () => {
      fallbackCalls += 1;
      return { configOptions: [] };
    },
  });

  await controller.beginTurn();
  const controls = [
    controller.setSessionMode("plan", 1_000),
    controller.setSessionModel("smart-model", 1_000),
    controller.setSessionConfigOption("reasoning_effort", "high", 1_000),
  ];
  await Promise.resolve();
  assert.equal(fallbackCalls, 0);

  controller.setActiveController(
    makeActiveController({
      setSessionMode: async (modeId) => {
        activeCalls.push(`mode:${modeId}`);
      },
      setSessionModel: async (modelId) => {
        activeCalls.push(`model:${modelId}`);
        return undefined;
      },
      setSessionConfigOption: async (configId, value) => {
        activeCalls.push(`${configId}:${value}`);
        return { configOptions: [] };
      },
    }),
  );

  await Promise.all(controls);
  assert.deepEqual(activeCalls.toSorted(), [
    "mode:plan",
    "model:smart-model",
    "reasoning_effort:high",
  ]);
  assert.equal(fallbackCalls, 0);
});

test("QueueOwnerTurnController routes combined preferences through active and fallback controllers", async () => {
  const activeRequests: Array<[string | undefined, string]> = [];
  const fallbackRequests: Array<[string | undefined, string, number | undefined]> = [];
  const observedTimeouts: Array<number | undefined> = [];
  const controller = createQueueOwnerTurnController({
    withTimeout: async (run, timeoutMs) => {
      observedTimeouts.push(timeoutMs);
      return await run();
    },
    applySessionPreferencesFallback: async (modelId, effort, timeoutMs) => {
      fallbackRequests.push([modelId, effort, timeoutMs]);
      return {
        effortConfigId: "thought_level",
        response: { configOptions: [] },
      };
    },
  });
  controller.setActiveController(
    makeActiveController({
      applySessionPreferences: async (modelId, effort) => {
        activeRequests.push([modelId, effort]);
        return {
          effortConfigId: "reasoning_effort",
          response: { configOptions: [] },
        };
      },
    }),
  );

  const activeResult = await controller.applySessionPreferences("smart-model", "xhigh", 900);
  assert.deepEqual(activeRequests, [["smart-model", "xhigh"]]);
  assert.deepEqual(fallbackRequests, []);
  assert.deepEqual(observedTimeouts, [900]);
  assert.equal(activeResult.effortConfigId, "reasoning_effort");

  controller.clearActiveController();
  const fallbackResult = await controller.applySessionPreferences(undefined, "low", 1_200);
  assert.deepEqual(fallbackRequests, [[undefined, "low", 1_200]]);
  assert.equal(fallbackResult.effortConfigId, "thought_level");
});

test("QueueOwnerTurnController waits for a starting turn before applying preferences", async () => {
  let activeCalls = 0;
  let fallbackCalls = 0;
  const controller = createQueueOwnerTurnController({
    applySessionPreferencesFallback: async () => {
      fallbackCalls += 1;
      return {
        effortConfigId: "reasoning_effort",
        response: { configOptions: [] },
      };
    },
  });

  await controller.beginTurn();
  const resultPromise = controller.applySessionPreferences("smart-model", "high", 1_000);
  await Promise.resolve();
  assert.equal(activeCalls, 0);
  assert.equal(fallbackCalls, 0);

  controller.setActiveController(
    makeActiveController({
      applySessionPreferences: async () => {
        activeCalls += 1;
        return {
          effortConfigId: "reasoning_effort",
          response: { configOptions: [] },
        };
      },
    }),
  );

  const result = await resultPromise;
  assert.equal(result.effortConfigId, "reasoning_effort");
  assert.equal(activeCalls, 1);
  assert.equal(fallbackCalls, 0);
});

test("QueueOwnerTurnController finishes idle preference updates before starting a turn", async () => {
  let releaseFallback!: () => void;
  const fallbackGate = new Promise<void>((resolve) => {
    releaseFallback = resolve;
  });
  let fallbackCalls = 0;
  const controller = createQueueOwnerTurnController({
    applySessionPreferencesFallback: async () => {
      fallbackCalls += 1;
      await fallbackGate;
      return {
        effortConfigId: "reasoning_effort",
        response: { configOptions: [] },
      };
    },
  });

  const preference = controller.applySessionPreferences("smart-model", "high", 1_000);
  await Promise.resolve();
  assert.equal(fallbackCalls, 1);

  let turnStarted = false;
  const beginTurn = controller.beginTurn().then(() => {
    turnStarted = true;
  });
  await Promise.resolve();
  assert.equal(turnStarted, false);
  assert.equal(controller.lifecycleState, "idle");

  releaseFallback();
  await preference;
  await beginTurn;
  assert.equal(turnStarted, true);
  assert.equal(controller.lifecycleState, "starting");
});

test("QueueOwnerTurnController releases the idle-control barrier during shutdown", async () => {
  let releaseFallback!: () => void;
  const fallbackGate = new Promise<void>((resolve) => {
    releaseFallback = resolve;
  });
  const controller = createQueueOwnerTurnController({
    applySessionPreferencesFallback: async () => {
      await fallbackGate;
      return {
        effortConfigId: "reasoning_effort",
        response: { configOptions: [] },
      };
    },
  });

  const preference = controller.applySessionPreferences("smart-model", "high");
  await Promise.resolve();
  const beginTurn = controller.beginTurn();
  await Promise.resolve();

  controller.prepareForShutdown();

  await assert.rejects(beginTurn, /Queue owner is closing/);
  await assert.rejects(
    async () => await controller.setSessionMode("plan"),
    /Queue owner is closing/,
  );
  assert.equal(controller.lifecycleState, "idle");

  releaseFallback();
  await preference;
});

test("QueueOwnerTurnController rejects control requests while closing", async () => {
  let setModeFallbackCalls = 0;
  let setModelFallbackCalls = 0;
  let setConfigFallbackCalls = 0;
  let applyPreferencesFallbackCalls = 0;
  const controller = createQueueOwnerTurnController({
    setSessionModeFallback: async () => {
      setModeFallbackCalls += 1;
    },
    setSessionModelFallback: async () => {
      setModelFallbackCalls += 1;
    },
    setSessionConfigOptionFallback: async () => {
      setConfigFallbackCalls += 1;
      return { configOptions: [] };
    },
    applySessionPreferencesFallback: async () => {
      applyPreferencesFallbackCalls += 1;
      return {
        effortConfigId: "reasoning_effort",
        response: { configOptions: [] },
      };
    },
  });

  controller.beginClosing();

  await assert.rejects(
    async () => await controller.setSessionMode("plan"),
    /Queue owner is closing/,
  );
  await assert.rejects(
    async () => await controller.setSessionModel("gpt-5.4"),
    /Queue owner is closing/,
  );
  await assert.rejects(
    async () => await controller.setSessionConfigOption("k", "v"),
    /Queue owner is closing/,
  );
  await assert.rejects(
    async () => await controller.applySessionPreferences("gpt-5.4", "high"),
    /Queue owner is closing/,
  );
  assert.equal(setModeFallbackCalls, 0);
  assert.equal(setModelFallbackCalls, 0);
  assert.equal(setConfigFallbackCalls, 0);
  assert.equal(applyPreferencesFallbackCalls, 0);
});

type QueueOwnerTurnControllerOverrides = Partial<{
  withTimeout: <T>(run: () => Promise<T>, timeoutMs?: number) => Promise<T>;
  setSessionModeFallback: (modeId: string, timeoutMs?: number) => Promise<void>;
  setSessionModelFallback: (
    modelId: string,
    timeoutMs?: number,
  ) => Promise<SetSessionConfigOptionResponse | undefined>;
  setSessionConfigOptionFallback: (
    configId: string,
    value: string,
    timeoutMs?: number,
  ) => Promise<SetSessionConfigOptionResponse>;
  applySessionPreferencesFallback: QueueOwnerTurnController["applySessionPreferences"];
}>;

function createQueueOwnerTurnController(
  overrides: QueueOwnerTurnControllerOverrides = {},
): QueueOwnerTurnController {
  const withTimeout =
    overrides.withTimeout ?? (async <T>(run: () => Promise<T>): Promise<T> => await run());
  const setSessionModeFallback =
    overrides.setSessionModeFallback ??
    (async (): Promise<void> => {
      // no-op
    });
  const setSessionModelFallback =
    overrides.setSessionModelFallback ??
    (async () => ({
      configOptions: [],
    }));
  const setSessionConfigOptionFallback =
    overrides.setSessionConfigOptionFallback ??
    (async () => ({
      configOptions: [],
    }));
  const applySessionPreferencesFallback =
    overrides.applySessionPreferencesFallback ??
    (async () => ({
      effortConfigId: "reasoning_effort",
      response: { configOptions: [] },
    }));

  return new QueueOwnerTurnController({
    withTimeout,
    setSessionModeFallback,
    setSessionModelFallback,
    setSessionConfigOptionFallback,
    applySessionPreferencesFallback,
  });
}

type ActiveControllerOverrides = Partial<QueueOwnerActiveSessionController>;

function makeActiveController(
  overrides: ActiveControllerOverrides = {},
): QueueOwnerActiveSessionController {
  return {
    hasActivePrompt: overrides.hasActivePrompt ?? (() => false),
    requestCancelActivePrompt: overrides.requestCancelActivePrompt ?? (async () => false),
    setSessionMode:
      overrides.setSessionMode ??
      (async () => {
        // no-op
      }),
    setSessionModel:
      overrides.setSessionModel ??
      (async () => ({
        configOptions: [],
      })),
    setSessionConfigOption:
      overrides.setSessionConfigOption ?? (async () => ({ configOptions: [] })),
    applySessionPreferences:
      overrides.applySessionPreferences ??
      (async () => ({
        effortConfigId: "reasoning_effort",
        response: { configOptions: [] },
      })),
  };
}
