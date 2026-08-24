import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import type { SessionModelState } from "../src/acp/model-support.js";
import {
  connectAndLoadSession,
  type ConnectedSessionController,
} from "../src/runtime/engine/reconnect.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
} from "./runtime-test-helpers.js";

type FakeClient = {
  hasReusableSession: (sessionId: string) => boolean;
  start: () => Promise<void>;
  getAgentLifecycleSnapshot: () => {
    pid?: number;
    startedAt?: string;
    running: boolean;
    lastExit?: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      exitedAt: string;
      reason: string;
    };
  };
  supportsLoadSession: () => boolean;
  supportsResumeSession?: () => boolean;
  resumeSession?: (
    sessionId: string,
    cwd: string,
  ) => Promise<{
    agentSessionId?: string;
    configOptions?: SetSessionConfigOptionResponse["configOptions"];
    models?: SessionModelState;
    configOptionsPresent?: boolean;
    legacyModelMetadataPresent?: boolean;
  }>;
  loadSessionWithOptions: (
    sessionId: string,
    cwd: string,
    options: { suppressReplayUpdates: boolean },
  ) => Promise<{
    agentSessionId?: string;
    configOptions?: SetSessionConfigOptionResponse["configOptions"];
    models?: SessionModelState;
    configOptionsPresent?: boolean;
    legacyModelMetadataPresent?: boolean;
  }>;
  createSession: (cwd: string) => Promise<{
    sessionId: string;
    agentSessionId?: string;
    configOptions?: SetSessionConfigOptionResponse["configOptions"];
    models?: SessionModelState;
    configOptionsPresent?: boolean;
    legacyModelMetadataPresent?: boolean;
  }>;
  setSessionMode: (sessionId: string, modeId: string) => Promise<void>;
  setSessionModel: (
    sessionId: string,
    modelId: string,
    controlOverride?: SessionModelState,
  ) => Promise<void | SetSessionConfigOptionResponse>;
  setSessionConfigOption?: (
    sessionId: string,
    configId: string,
    value: string,
  ) => Promise<SetSessionConfigOptionResponse>;
};

const ACTIVE_CONTROLLER: ConnectedSessionController & {
  setSessionModel: (modelId: string) => Promise<void>;
} = {
  hasActivePrompt: () => false,
  requestCancelActivePrompt: async () => false,
  setSessionMode: async () => {},
  setSessionModel: async () => {},
  setSessionConfigOption: async () => ({
    configOptions: [],
  }),
};

function buildModelsState(currentModelId: string): SessionModelState {
  return {
    configId: "model",
    currentModelId,
    availableModels: [
      { modelId: "default-model", name: "default-model" },
      { modelId: "gpt-5.4", name: "gpt-5.4" },
    ],
  };
}

test("connectAndLoadSession prefers session/resume for resume-capable sessions", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "resume-record",
      acpSessionId: "resume-session",
      agentCommand: "agent",
      cwd,
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => false,
      supportsResumeSession: () => true,
      resumeSession: async (sessionId, resumeCwd) => {
        assert.equal(sessionId, "resume-session");
        assert.equal(resumeCwd, cwd);
        return { agentSessionId: "runtime-session" };
      },
      loadSessionWithOptions: async () => {
        throw new Error("loadSessionWithOptions should not be called");
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.deepEqual(result, {
      sessionId: "resume-session",
      agentSessionId: "runtime-session",
      resumed: true,
      loadError: undefined,
    });
    assert.equal(record.agentSessionId, "runtime-session");
  });
});

test("connectAndLoadSession resumes an existing load-capable session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "resume-record",
      acpSessionId: "resume-session",
      agentCommand: "agent",
      cwd,
      closed: true,
      closedAt: "2026-01-01T00:05:00.000Z",
    });

    let clientAvailableCalls = 0;
    let connectedRecordCalls = 0;
    let resolvedSessionId: string | undefined;
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        pid: 777,
        startedAt: "2026-01-01T00:00:00.000Z",
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async (sessionId, loadCwd, options) => {
        assert.equal(sessionId, "resume-session");
        assert.equal(loadCwd, cwd);
        assert.deepEqual(options, { suppressReplayUpdates: true });
        return { agentSessionId: "runtime-session" };
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
      onClientAvailable: (controller) => {
        clientAvailableCalls += 1;
        assert.equal(controller, ACTIVE_CONTROLLER);
      },
      onConnectedRecord: (connectedRecord) => {
        connectedRecordCalls += 1;
        assert.equal(connectedRecord.closed, false);
        assert.equal(connectedRecord.closedAt, undefined);
      },
      onSessionIdResolved: (sessionId) => {
        resolvedSessionId = sessionId;
      },
    });

    assert.deepEqual(result, {
      sessionId: "resume-session",
      agentSessionId: "runtime-session",
      resumed: true,
      loadError: undefined,
    });
    assert.equal(clientAvailableCalls, 1);
    assert.equal(connectedRecordCalls, 1);
    assert.equal(resolvedSessionId, "resume-session");
    assert.equal(record.pid, 777);
    assert.equal(record.agentStartedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(record.agentSessionId, "runtime-session");
  });
});

test("connectAndLoadSession re-applies saved effort before publishing a rebound client", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const events: string[] = [];
    const record = makeSessionRecord({
      acpxRecordId: "rebound-effort-record",
      acpSessionId: "rebound-effort-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        session_options: { effort: "high" },
        desired_config_options: { reasoning_effort: "high" },
        config_options: effortConfigOptions("high"),
      },
    });
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {
        events.push("start");
      },
      getAgentLifecycleSnapshot: () => ({ running: true }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        events.push("load");
        return {
          configOptions: effortConfigOptions("medium"),
          configOptionsPresent: true,
          legacyModelMetadataPresent: false,
        };
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
      setSessionConfigOption: async (sessionId, configId, value) => {
        events.push(`set:${configId}:${value}`);
        assert.equal(sessionId, "rebound-effort-session");
        return { configOptions: effortConfigOptions(value) };
      },
    };

    await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
      onClientAvailable: () => {
        events.push("available");
      },
    });

    assert.deepEqual(events, ["start", "load", "set:reasoning_effort:high", "available"]);
    assert.equal(record.acpx?.session_options?.effort, "high");
    assert.equal(record.acpx?.config_options?.[0]?.currentValue, "high");
  });
});

test("connectAndLoadSession forces saved effort replay when rebound metadata is sparse", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const calls: string[] = [];
    const record = makeSessionRecord({
      acpxRecordId: "sparse-effort-record",
      acpSessionId: "sparse-effort-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        session_options: { model: "smart-model", effort: "high" },
        desired_config_options: { reasoning_effort: "high" },
        current_model_id: "default-model",
        available_models: ["default-model", "smart-model"],
        model_control: "legacy_set_model",
        config_options: effortConfigOptions("high"),
      },
    });
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({ running: true }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => ({
        configOptionsPresent: false,
        legacyModelMetadataPresent: false,
      }),
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async (_sessionId, modelId) => {
        calls.push(`model:${modelId}`);
      },
      setSessionConfigOption: async (_sessionId, configId, value) => {
        calls.push(`${configId}:${value}`);
        return { configOptions: effortConfigOptions(value) };
      },
    };

    await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.deepEqual(calls, ["model:smart-model", "reasoning_effort:high"]);
    assert.equal(record.acpx?.session_options?.model, "smart-model");
    assert.equal(record.acpx?.session_options?.effort, "high");
    assert.equal(record.acpx?.config_options?.[0]?.currentValue, "high");
  });
});

test("connectAndLoadSession retains legacy model state when load omits model metadata", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "legacy-model-record",
      acpSessionId: "legacy-model-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        current_model_id: "legacy-model",
        available_models: ["legacy-model"],
        model_control: "legacy_set_model",
        config_options: [],
      },
    });
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({ running: true }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => ({
        configOptions: [
          {
            id: "reasoning_effort",
            name: "Reasoning Effort",
            type: "select",
            currentValue: "medium",
            options: [{ value: "medium", name: "Medium" }],
          },
        ],
        configOptionsPresent: true,
        legacyModelMetadataPresent: false,
      }),
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await connectAndLoadSession({
      client: client as never,
      record,
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(record.acpx?.current_model_id, "legacy-model");
    assert.deepEqual(record.acpx?.available_models, ["legacy-model"]);
    assert.equal(record.acpx?.model_control, "legacy_set_model");
  });
});

test("connectAndLoadSession lets explicit legacy metadata replace stale model config", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "legacy-replacement-record",
      acpSessionId: "legacy-replacement-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        current_model_id: "config-model",
        available_models: ["config-model"],
        model_control: "config_option",
        config_options: [
          {
            id: "llm",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "config-model",
            options: [{ value: "config-model", name: "Config Model" }],
          },
          {
            id: "reasoning_effort",
            name: "Reasoning Effort",
            type: "select",
            currentValue: "medium",
            options: [{ value: "medium", name: "Medium" }],
          },
        ],
      },
    });
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({ running: true }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => ({
        models: {
          currentModelId: "legacy-model",
          availableModels: [{ modelId: "legacy-model", name: "Legacy Model" }],
        },
        configOptionsPresent: false,
        legacyModelMetadataPresent: true,
      }),
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await connectAndLoadSession({
      client: client as never,
      record,
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(record.acpx?.current_model_id, "legacy-model");
    assert.equal(record.acpx?.model_control, "legacy_set_model");
    assert.deepEqual(
      record.acpx?.config_options?.map((option) => option.id),
      ["reasoning_effort"],
    );
  });
});

test("connectAndLoadSession uses rebound legacy metadata when replaying a saved model", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "legacy-model-replay-record",
      acpSessionId: "legacy-model-replay-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        session_options: { model: "smart-model" },
        current_model_id: "stale-config-model",
        available_models: ["stale-config-model", "smart-model"],
        model_control: "config_option",
        config_options: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "stale-config-model",
            options: [
              { value: "stale-config-model", name: "Stale" },
              { value: "smart-model", name: "Smart" },
            ],
          },
        ],
      },
    });
    const modelCalls: Array<{ sessionId: string; modelId: string; models?: SessionModelState }> =
      [];
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({ running: true }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => ({
        models: {
          currentModelId: "legacy-default",
          availableModels: [
            { modelId: "legacy-default", name: "Legacy Default" },
            { modelId: "smart-model", name: "Smart" },
          ],
        },
        configOptionsPresent: false,
        legacyModelMetadataPresent: true,
      }),
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async (sessionId, modelId, models) => {
        modelCalls.push({ sessionId, modelId, models });
      },
    };

    await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.deepEqual(modelCalls, [
      {
        sessionId: "legacy-model-replay-session",
        modelId: "smart-model",
        models: {
          currentModelId: "legacy-default",
          availableModels: [
            { modelId: "legacy-default", name: "Legacy Default" },
            { modelId: "smart-model", name: "Smart" },
          ],
        },
      },
    ]);
    assert.equal(record.acpx?.model_control, "legacy_set_model");
    assert.equal(record.acpx?.current_model_id, "smart-model");
    assert.deepEqual(record.acpx?.available_models, ["legacy-default", "smart-model"]);
  });
});

test("connectAndLoadSession falls back to createSession when load returns resource-not-found", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "fallback-record",
      acpSessionId: "old-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        current_model_id: "old-model",
        available_models: ["old-model"],
        model_control: "config_option",
        config_options: [
          {
            id: "old-model-selector",
            name: "Old Model",
            category: "model",
            type: "select",
            currentValue: "old-model",
            options: [{ value: "old-model", name: "Old Model" }],
          },
        ],
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async (createCwd) => {
        assert.equal(createCwd, cwd);
        return {
          sessionId: "new-session",
          agentSessionId: "new-runtime",
          configOptionsPresent: false,
          legacyModelMetadataPresent: false,
        };
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.resumed, false);
    assert.equal(result.sessionId, "new-session");
    assert.equal(result.agentSessionId, "new-runtime");
    assert.match(result.loadError ?? "", /session not found/);
    assert.equal(record.acpSessionId, "new-session");
    assert.equal(record.agentSessionId, "new-runtime");
    assert.equal(record.acpx?.config_options, undefined);
    assert.equal(record.acpx?.current_model_id, undefined);
    assert.equal(record.acpx?.model_control, undefined);
  });
});

test("connectAndLoadSession fails instead of creating a fresh session when resume policy requires the same session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "strict-resume-record",
      acpSessionId: "strict-resume-session",
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "a turn that must not be discarded" }],
            tool_results: {},
          },
        },
      ],
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          resumePolicy: "same-session-only",
          timeoutMs: 1_000,
          activeController: ACTIVE_CONTROLLER,
        }),
      /Persistent ACP session strict-resume-session could not be resumed: .*session not found/i,
    );

    assert.equal(record.acpSessionId, "strict-resume-session");
  });
});

test("connectAndLoadSession rebinds an untouched record the adapter no longer knows", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "untouched-record",
      acpSessionId: "forgotten-session",
      agentCommand: "agent",
      cwd,
      acpx: { desired_mode_id: "plan" },
    });

    const modes: string[] = [];
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({ running: true }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => true,
      resumeSession: async () => {
        throw {
          error: {
            code: -32002,
            message: "Resource not found: forgotten-session",
          },
        };
      },
      loadSessionWithOptions: async () => {
        throw new Error("loadSession should not be called");
      },
      createSession: async () => ({
        sessionId: "rebound-session",
        agentSessionId: "rebound-runtime",
      }),
      setSessionMode: async (_sessionId: string, modeId: string) => {
        modes.push(modeId);
      },
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      resumePolicy: "same-session-only",
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.resumed, false);
    assert.equal(result.sessionId, "rebound-session");
    assert.equal(record.acpSessionId, "rebound-session");
    assert.match(result.loadError ?? "", /Resource not found/);
    assert.deepEqual(modes, ["plan"]);
  });
});

test("connectAndLoadSession rebinds an untouched record when the adapter answers an internal error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "untouched-internal-record",
      acpSessionId: "untouched-internal-session",
      agentCommand: "agent",
      cwd,
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({ running: true }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => true,
      resumeSession: async () => {
        throw {
          error: {
            code: -32603,
            message: "Internal error",
          },
        };
      },
      loadSessionWithOptions: async () => {
        throw new Error("loadSession should not be called");
      },
      createSession: async () => ({
        sessionId: "rebound-internal-session",
        agentSessionId: "rebound-internal-runtime",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      resumePolicy: "same-session-only",
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.sessionId, "rebound-internal-session");
    assert.equal(record.acpSessionId, "rebound-internal-session");
  });
});

test("connectAndLoadSession keeps an untouched record when the rebind attempt times out", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "untouched-timeout-record",
      acpSessionId: "untouched-timeout-session",
      agentCommand: "agent",
      cwd,
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({ running: true }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => true,
      resumeSession: async () => await new Promise(() => {}),
      loadSessionWithOptions: async () => {
        throw new Error("loadSession should not be called");
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          resumePolicy: "same-session-only",
          timeoutMs: 25,
          activeController: ACTIVE_CONTROLLER,
        }),
      /Persistent ACP session untouched-timeout-session could not be resumed/i,
    );

    assert.equal(record.acpSessionId, "untouched-timeout-session");
  });
});

test("connectAndLoadSession requires the same provider session for imported records", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "imported-record",
      acpSessionId: "imported-provider-session",
      agentCommand: "agent",
      cwd,
      importedFrom: {
        recordId: "source-record",
        cwdOriginal: "/source/workspace",
        exportedBy: "source-user",
        exportedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          timeoutMs: 1_000,
          activeController: ACTIVE_CONTROLLER,
        }),
      /Persistent ACP session imported-provider-session could not be resumed: .*session not found/i,
    );

    assert.equal(record.acpSessionId, "imported-provider-session");
  });
});

test("connectAndLoadSession falls back to createSession for empty sessions on adapter internal errors", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "empty-record",
      acpSessionId: "empty-session",
      agentCommand: "agent",
      cwd,
      messages: [],
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32603,
            message: "internal error",
          },
        };
      },
      createSession: async () => ({
        sessionId: "created-for-empty",
        agentSessionId: "created-runtime",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.sessionId, "created-for-empty");
    assert.equal(result.resumed, false);
    assert.equal(record.acpSessionId, "created-for-empty");
    assert.equal(record.agentSessionId, "created-runtime");
  });
});

test("connectAndLoadSession creates the first provider session when an empty record cannot be resumed", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "unsupported-load-record",
      acpSessionId: "unsupported-load-session",
      agentCommand: "agent",
      cwd,
      agentCapabilities: {},
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => false,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw new Error("loadSession should not be called");
      },
      createSession: async () => ({
        sessionId: "first-provider-session",
        agentSessionId: "first-runtime-session",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      resumePolicy: "same-session-only",
      allowFreshSessionForFirstPrompt: true,
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.sessionId, "first-provider-session");
    assert.equal(result.agentSessionId, "first-runtime-session");
    assert.equal(result.resumed, false);
    assert.equal(record.acpSessionId, "first-provider-session");
  });
});

test("connectAndLoadSession keeps direct operations strict for an empty record", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "strict-empty-record",
      acpSessionId: "strict-empty-session",
      agentCommand: "agent",
      cwd,
      agentCapabilities: {},
    });
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({ running: true }),
      supportsLoadSession: () => false,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw new Error("loadSession should not be called");
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          resumePolicy: "same-session-only",
          timeoutMs: 1_000,
          activeController: ACTIVE_CONTROLLER,
        }),
      /Persistent ACP session strict-empty-session could not be resumed/i,
    );
  });
});

test("connectAndLoadSession fails clearly when recorded history cannot be resumed", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "unsupported-history-record",
      acpSessionId: "unsupported-history-session",
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "history that must not be replaced" }],
            tool_results: {},
          },
        },
      ],
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => false,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw new Error("loadSession should not be called");
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          resumePolicy: "same-session-only",
          timeoutMs: 1_000,
          activeController: ACTIVE_CONTROLLER,
        }),
      /Persistent ACP session unsupported-history-session could not be resumed: agent does not support session\/resume or session\/load/i,
    );
  });
});

test("connectAndLoadSession falls back to session/new on -32602 Invalid params", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "invalid-params-record",
      acpSessionId: "invalid-params-session",
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "has history" }],
            tool_results: {},
          },
        },
      ],
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32602,
            message: "Invalid params",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fallback-from-32602",
        agentSessionId: "fallback-runtime",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.sessionId, "fallback-from-32602");
    assert.equal(result.resumed, false);
    assert.equal(record.acpSessionId, "fallback-from-32602");
  });
});

test("connectAndLoadSession falls back to session/new on -32601 Method not found", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "method-not-found-record",
      acpSessionId: "method-not-found-session",
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "has history" }],
            tool_results: {},
          },
        },
      ],
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32601,
            message: "Method not found",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fallback-from-32601",
        agentSessionId: "fallback-runtime",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.sessionId, "fallback-from-32601");
    assert.equal(result.resumed, false);
    assert.equal(record.acpSessionId, "fallback-from-32601");
  });
});

test("connectAndLoadSession rethrows load failures that should not create a new session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "agent-history-record",
      acpSessionId: "agent-history-session",
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "already responded" }],
            tool_results: {},
          },
        },
      ],
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32603,
            message: "still broken",
          },
        };
      },
      createSession: async () => ({
        sessionId: "unexpected",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      (error: unknown) => {
        assert.deepEqual(error, {
          error: {
            code: -32603,
            message: "still broken",
          },
        });
        return true;
      },
    );
  });
});

test("connectAndLoadSession fails when desired mode replay cannot be restored on a fresh session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "mode-replay-record",
      acpSessionId: "stale-session",
      agentSessionId: "stale-runtime",
      agentCommand: "agent",
      cwd,
      acpx: {
        desired_mode_id: "plan",
        current_model_id: "old-model",
        available_models: ["old-model"],
        model_control: "legacy_set_model",
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fresh-session",
        agentSessionId: "fresh-runtime",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "fresh-model",
            options: [{ value: "fresh-model", name: "Fresh Model" }],
          },
        ],
        configOptionsPresent: true,
        legacyModelMetadataPresent: false,
        models: {
          configId: "model",
          currentModelId: "fresh-model",
          availableModels: [{ modelId: "fresh-model", name: "Fresh Model" }],
        },
      }),
      setSessionMode: async (sessionId, modeId) => {
        assert.equal(sessionId, "fresh-session");
        assert.equal(modeId, "plan");
        throw new Error("mode restore rejected");
      },
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "SessionModeReplayError");
        assert.equal((error as Error & { retryable?: boolean }).retryable, true);
        assert.match(error.message, /Failed to replay saved session mode plan/);
        return true;
      },
    );
    assert.equal(record.acpSessionId, "stale-session");
    assert.equal(record.agentSessionId, "stale-runtime");
    assert.equal(record.acpx?.current_model_id, "old-model");
    assert.deepEqual(record.acpx?.available_models, ["old-model"]);
    assert.equal(record.acpx?.model_control, "legacy_set_model");
  });
});

type SetModeCall = {
  sessionId: string;
  modeId: string;
};

/**
 * A client whose reconnect hands the record a *new* adapter session behind the
 * same acpx session id, which is what `session/resume` and `session/load` both
 * do after a queue-owner restart or an agent process death.
 */
function makeReboundSessionClient(params: {
  setModeCalls: SetModeCall[];
  reusableSessionId?: string;
  resumeCapable?: boolean;
  refuseSetSessionMode?: boolean;
  onStart?: () => void;
}): FakeClient {
  return {
    hasReusableSession: (sessionId) => sessionId === params.reusableSessionId,
    start: async () => {
      params.onStart?.();
    },
    getAgentLifecycleSnapshot: () => ({
      running: true,
    }),
    supportsLoadSession: () => params.resumeCapable !== true,
    supportsResumeSession: () => params.resumeCapable === true,
    resumeSession: async () => ({ agentSessionId: "runtime-session" }),
    loadSessionWithOptions: async () => ({ agentSessionId: "runtime-session" }),
    createSession: async () => {
      throw new Error("createSession should not be called");
    },
    setSessionMode: async (sessionId, modeId) => {
      params.setModeCalls.push({ sessionId, modeId });
      if (params.refuseSetSessionMode) {
        throw new Error("unsupported mode");
      }
    },
    setSessionModel: async () => {},
  };
}

async function connectReboundSession(params: {
  homeDir: string;
  client: FakeClient;
  desiredModeId?: string;
  onWarning?: Parameters<typeof connectAndLoadSession>[0]["onWarning"];
}): Promise<{
  record: ReturnType<typeof makeSessionRecord>;
  result: Awaited<ReturnType<typeof connectAndLoadSession>>;
}> {
  const cwd = path.join(params.homeDir, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  const record = makeSessionRecord({
    acpxRecordId: "rebound-record",
    acpSessionId: "bound-session",
    agentCommand: "agent",
    cwd,
    ...(params.desiredModeId ? { acpx: { desired_mode_id: params.desiredModeId } } : {}),
  });

  const result = await connectAndLoadSession({
    client: params.client as never,
    record,
    timeoutMs: 1_000,
    activeController: ACTIVE_CONTROLLER,
    onWarning: params.onWarning,
  });

  return { record, result };
}

test("connectAndLoadSession re-applies the stored mode on a resumed adapter session", async () => {
  await withTempHome(async (homeDir) => {
    const setModeCalls: SetModeCall[] = [];
    const { result } = await connectReboundSession({
      homeDir,
      client: makeReboundSessionClient({ setModeCalls, resumeCapable: true }),
      desiredModeId: "plan",
    });

    assert.equal(result.resumed, true);
    assert.deepEqual(setModeCalls, [{ sessionId: "bound-session", modeId: "plan" }]);
  });
});

test("connectAndLoadSession re-applies the stored mode after session/load", async () => {
  await withTempHome(async (homeDir) => {
    const setModeCalls: SetModeCall[] = [];
    const { result } = await connectReboundSession({
      homeDir,
      client: makeReboundSessionClient({ setModeCalls }),
      desiredModeId: "read-only",
    });

    assert.equal(result.resumed, true);
    assert.deepEqual(setModeCalls, [{ sessionId: "bound-session", modeId: "read-only" }]);
  });
});

test("connectAndLoadSession leaves a rebound session alone when no mode was ever set", async () => {
  await withTempHome(async (homeDir) => {
    const setModeCalls: SetModeCall[] = [];
    await connectReboundSession({
      homeDir,
      client: makeReboundSessionClient({ setModeCalls, resumeCapable: true }),
    });

    assert.deepEqual(setModeCalls, []);
  });
});

test("connectAndLoadSession does not re-apply the stored mode onto a reused live session", async () => {
  await withTempHome(async (homeDir) => {
    const setModeCalls: SetModeCall[] = [];
    let started = false;
    await connectReboundSession({
      homeDir,
      client: makeReboundSessionClient({
        setModeCalls,
        reusableSessionId: "bound-session",
        onStart: () => {
          started = true;
        },
      }),
      desiredModeId: "plan",
    });

    // Reusing a session this client already holds is not a new binding, so it
    // keeps whatever mode the live session is already running under.
    assert.equal(started, false);
    assert.deepEqual(setModeCalls, []);
  });
});

test("connectAndLoadSession warns and keeps the turn when a rebound adapter refuses the stored mode", async () => {
  await withTempHome(async (homeDir) => {
    const setModeCalls: SetModeCall[] = [];
    const warnings: Array<{ code: string; modeId: string; sessionId: string; message: string }> =
      [];
    const { record, result } = await connectReboundSession({
      homeDir,
      client: makeReboundSessionClient({
        setModeCalls,
        resumeCapable: true,
        refuseSetSessionMode: true,
      }),
      desiredModeId: "plan",
      onWarning: (warning) => {
        warnings.push(warning);
      },
    });

    assert.equal(result.resumed, true);
    assert.deepEqual(setModeCalls, [{ sessionId: "bound-session", modeId: "plan" }]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.code, "SESSION_MODE_NOT_REAPPLIED");
    assert.equal(warnings[0]?.modeId, "plan");
    assert.equal(warnings[0]?.sessionId, "bound-session");
    assert.match(warnings[0]?.message ?? "", /is not in force/);
    // The preference stays saved so the next binding tries again.
    assert.equal(record.acpx?.desired_mode_id, "plan");
  });
});

test("connectAndLoadSession replays desired model on a fresh session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "model-replay-record",
      acpSessionId: "stale-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        session_options: {
          model: "gpt-5.4",
        },
      },
    });

    let setModelCalls = 0;
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fresh-session",
        agentSessionId: "fresh-runtime",
        models: buildModelsState("default-model"),
      }),
      setSessionMode: async () => {},
      setSessionModel: async (sessionId, modelId) => {
        setModelCalls += 1;
        assert.equal(sessionId, "fresh-session");
        assert.equal(modelId, "gpt-5.4");
        return {
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "gpt-5.4",
              options: [{ value: "gpt-5.4", name: "gpt-5.4" }],
            },
          ],
        };
      },
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.sessionId, "fresh-session");
    assert.equal(result.resumed, false);
    assert.equal(setModelCalls, 1);
    assert.equal(record.acpSessionId, "fresh-session");
    assert.equal(record.acpx?.current_model_id, "gpt-5.4");
    assert.deepEqual(record.acpx?.available_models, ["gpt-5.4"]);
  });
});

test("connectAndLoadSession fails clearly when saved model cannot be replayed generically", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "model-replay-unsupported-record",
      acpSessionId: "stale-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        session_options: {
          model: "gpt-5.4",
        },
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => false,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw new Error("loadSessionWithOptions should not be called");
      },
      createSession: async () => ({
        sessionId: "fresh-session",
        agentSessionId: "fresh-runtime",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {
        throw new Error("setSessionModel should not be called");
      },
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "SessionModelReplayError");
        assert.match(error.message, /did not advertise model support/);
        return true;
      },
    );

    assert.equal(record.acpSessionId, "stale-session");
  });
});

test("connectAndLoadSession restores the original session when desired model replay fails", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "model-replay-failure-record",
      acpSessionId: "stale-session",
      agentSessionId: "stale-runtime",
      agentCommand: "agent",
      cwd,
      acpx: {
        session_options: {
          model: "gpt-5.4",
        },
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fresh-session",
        agentSessionId: "fresh-runtime",
        models: buildModelsState("default-model"),
      }),
      setSessionMode: async () => {},
      setSessionModel: async (sessionId, modelId) => {
        assert.equal(sessionId, "fresh-session");
        assert.equal(modelId, "gpt-5.4");
        throw new Error("model restore rejected");
      },
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "SessionModelReplayError");
        assert.equal((error as Error & { retryable?: boolean }).retryable, true);
        assert.match(error.message, /Failed to replay saved session model gpt-5\.4/);
        return true;
      },
    );

    assert.equal(record.acpSessionId, "stale-session");
    assert.equal(record.agentSessionId, "stale-runtime");
    assert.equal(record.acpx?.current_model_id, undefined);
  });
});

test("connectAndLoadSession replays desired config options on a fresh session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "config-replay-record",
      acpSessionId: "stale-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        desired_config_options: {
          reasoning_effort: "high",
        },
      },
    });

    const configCalls: Array<{ sessionId: string; configId: string; value: string }> = [];
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fresh-session",
        agentSessionId: "fresh-runtime",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {},
      setSessionConfigOption: async (sessionId, configId, value) => {
        configCalls.push({ sessionId, configId, value });
        return {
          configOptions: [
            {
              id: "llm",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "replayed-model",
              options: [{ value: "replayed-model", name: "Replayed Model" }],
            },
            {
              id: "reasoning_effort",
              name: "Reasoning Effort",
              type: "select",
              currentValue: "high",
              options: [{ value: "high", name: "High" }],
            },
          ],
        };
      },
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.sessionId, "fresh-session");
    assert.equal(result.resumed, false);
    assert.deepEqual(configCalls, [
      {
        sessionId: "fresh-session",
        configId: "reasoning_effort",
        value: "high",
      },
    ]);
    assert.equal(record.acpx?.current_model_id, "replayed-model");
    assert.equal(record.acpx?.model_control, "config_option");
    assert.deepEqual(
      record.acpx?.config_options?.map((option) => option.id),
      ["llm", "reasoning_effort"],
    );
  });
});

test("connectAndLoadSession preserves legacy models after config option replay", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "legacy-model-config-replay-record",
      acpSessionId: "stale-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        current_model_id: "legacy-model",
        available_models: ["legacy-model"],
        model_control: "legacy_set_model",
        desired_config_options: {
          reasoning_effort: "high",
        },
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({ running: true }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fresh-session",
        models: {
          currentModelId: "legacy-model",
          availableModels: [{ modelId: "legacy-model", name: "Legacy Model" }],
        },
        configOptionsPresent: false,
        legacyModelMetadataPresent: true,
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {},
      setSessionConfigOption: async () => ({
        configOptions: [
          {
            id: "reasoning_effort",
            name: "Reasoning Effort",
            type: "select",
            currentValue: "high",
            options: [{ value: "high", name: "High" }],
          },
        ],
      }),
    };

    await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(record.acpx?.current_model_id, "legacy-model");
    assert.deepEqual(record.acpx?.available_models, ["legacy-model"]);
    assert.equal(record.acpx?.model_control, "legacy_set_model");
    assert.deepEqual(
      record.acpx?.config_options?.map((option) => option.id),
      ["reasoning_effort"],
    );
  });
});

test("connectAndLoadSession restores the original session when desired config replay fails", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "config-replay-failure-record",
      acpSessionId: "stale-session",
      agentSessionId: "stale-runtime",
      agentCommand: "agent",
      cwd,
      acpx: {
        desired_config_options: {
          reasoning_effort: "xhigh",
        },
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fresh-session",
        agentSessionId: "fresh-runtime",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {},
      setSessionConfigOption: async (sessionId, configId, value) => {
        assert.equal(sessionId, "fresh-session");
        assert.equal(configId, "reasoning_effort");
        assert.equal(value, "xhigh");
        throw new Error("config restore rejected");
      },
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "SessionConfigOptionReplayError");
        assert.equal((error as Error & { retryable?: boolean }).retryable, true);
        assert.match(
          error.message,
          /Failed to replay saved session config option reasoning_effort/,
        );
        return true;
      },
    );

    assert.equal(record.acpSessionId, "stale-session");
    assert.equal(record.agentSessionId, "stale-runtime");
  });
});

test("connectAndLoadSession reuses an already loaded client session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "reused-record",
      acpSessionId: "reused-session",
      agentCommand: "agent",
      cwd,
    });

    let started = false;
    let loaded = false;
    const client: FakeClient = {
      hasReusableSession: (sessionId) => sessionId === "reused-session",
      start: async () => {
        started = true;
      },
      getAgentLifecycleSnapshot: () => ({
        pid: 888,
        startedAt: "2026-01-01T00:00:00.000Z",
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        loaded = true;
        return {};
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(started, false);
    assert.equal(loaded, false);
    assert.equal(result.resumed, true);
    assert.equal(result.sessionId, "reused-session");
    assert.equal(record.pid, 888);
  });
});

function makeSessionRecord(
  overrides: Parameters<typeof makeSessionRecordFixture>[0],
): ReturnType<typeof makeSessionRecordFixture> {
  return makeSessionRecordFixture(overrides, { defaultName: false, defaultAcpx: false });
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-connect-load-home-", run);
}

function effortConfigOptions(
  currentValue: string,
): SetSessionConfigOptionResponse["configOptions"] {
  return [
    {
      id: "reasoning_effort",
      name: "Reasoning Effort",
      category: "thought_level",
      type: "select",
      currentValue,
      options: [
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ];
}
