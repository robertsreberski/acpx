import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { effortStateFromConfigOptions } from "../../acp/effort-support.js";
import { withTimeout } from "../../async-control.js";
import {
  withConnectedSession,
  type FullConnectedSessionController,
  type WithConnectedSessionOptions,
  type WithConnectedSessionResult,
} from "../../runtime/engine/connected-session.js";
import { applyConfigOptionsToRecord } from "../../session/config-options.js";
import { cloneSessionAcpxState } from "../../session/conversation-model.js";
import {
  getDesiredModelId,
  setCurrentModelId,
  setDesiredConfigOption,
  setDesiredEffort,
  setDesiredModeId,
  setDesiredModelId,
} from "../../session/mode-preference.js";
import {
  applyRequestedModelAndEffortIfAdvertised,
  applyRequestedModelPreferenceToRecord,
  applyRequestedPreferencesToRecord,
  clearDesiredEffortAfterUnrefreshedModelChange,
  currentModelIdFromSetModelResponse,
  reapplyDesiredEffortAfterModelChange,
} from "../../session/model-application.js";
import { advertisedModelState } from "../../session/model-state.js";
import { resolveSessionRecord, writeSessionRecord } from "../../session/persistence.js";
import type {
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  SessionSetConfigOptionResult,
  SessionSetModelResult,
  SessionSetModeResult,
} from "../../types.js";
import type { QueueOwnerActiveSessionController } from "../queue/owner-turn-controller.js";

export type ActiveSessionController = QueueOwnerActiveSessionController;

export type RunSessionSetModeDirectOptions = {
  sessionRecordId: string;
  modeId: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  fs?: boolean;
  terminal?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

export type RunSessionSetConfigOptionDirectOptions = {
  sessionRecordId: string;
  configId: string;
  value: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  fs?: boolean;
  terminal?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

export type RunSessionSetModelDirectOptions = {
  sessionRecordId: string;
  modelId: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  fs?: boolean;
  terminal?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

export type RunSessionApplyPreferencesDirectOptions = DirectConnectedSessionOptions & {
  modelId?: string;
  effort: string;
  onModelWarning?: (message: string) => void;
};

export type RunSessionApplyPreferencesDirectResult = {
  record: SessionSetModeResult["record"];
  effortConfigId: string;
  response: SetSessionConfigOptionResponse;
  resumed: boolean;
  loadError?: string;
};

type DirectConnectedSessionOptions = {
  sessionRecordId: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  fs?: boolean;
  terminal?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

function buildDirectConnectedSessionOptions<T>(
  options: DirectConnectedSessionOptions,
  run: WithConnectedSessionOptions<T>["run"],
): WithConnectedSessionOptions<T> {
  return {
    sessionRecordId: options.sessionRecordId,
    loadRecord: resolveSessionRecord,
    saveRecord: writeSessionRecord,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
    onClientAvailable: (controller: FullConnectedSessionController) => {
      options.onClientAvailable?.(controller);
    },
    onClientClosed: options.onClientClosed,
    run,
  };
}

function toSessionMutationResult(
  result: Pick<WithConnectedSessionResult<unknown>, "record" | "resumed" | "loadError">,
): Pick<SessionSetModeResult, "record" | "resumed" | "loadError"> {
  return {
    record: result.record,
    resumed: result.resumed,
    loadError: result.loadError,
  };
}

export async function runSessionSetModeDirect(
  options: RunSessionSetModeDirectOptions,
): Promise<SessionSetModeResult> {
  const result = await withConnectedSession(
    buildDirectConnectedSessionOptions(options, async ({ client, sessionId, record }) => {
      await withTimeout(client.setSessionMode(sessionId, options.modeId), options.timeoutMs);
      setDesiredModeId(record, options.modeId);
    }),
  );

  return toSessionMutationResult(result);
}

export async function runSessionSetModelDirect(
  options: RunSessionSetModelDirectOptions,
): Promise<SessionSetModelResult> {
  const result = await withConnectedSession(
    buildDirectConnectedSessionOptions(options, async ({ client, sessionId, record }) => {
      const previousState = cloneSessionAcpxState(record.acpx);
      const models = advertisedModelState(record.acpx);
      const response = await withTimeout(
        client.setSessionModel(sessionId, options.modelId, models),
        options.timeoutMs,
      );
      applyConfigOptionsToRecord(record, response);
      setDesiredModelId(record, options.modelId, models?.configId);
      setCurrentModelId(record, currentModelIdFromSetModelResponse(response, options.modelId));
      if (!response) {
        record.acpx = clearDesiredEffortAfterUnrefreshedModelChange({
          state: record.acpx,
          modelResponse: response,
          previousModelId: models?.currentModelId,
          requestedModelId: options.modelId,
          previousEffortConfigId: effortStateFromConfigOptions(previousState?.config_options)
            ?.configId,
        });
        return response;
      }
      const effort = await reapplyDesiredEffortAfterModelChange({
        client,
        sessionId,
        previousState,
        nextState: record.acpx,
        timeoutMs: options.timeoutMs,
        onReconciledState: (state) => {
          record.acpx = state;
        },
      });
      record.acpx = effort.state;
      return effort.response ?? response;
    }),
  );

  return { ...toSessionMutationResult(result), response: result.value };
}

export async function runSessionApplyPreferencesDirect(
  options: RunSessionApplyPreferencesDirectOptions,
): Promise<RunSessionApplyPreferencesDirectResult> {
  const result = await withConnectedSession(
    buildDirectConnectedSessionOptions(options, async ({ client, sessionId, record }) => {
      const models = advertisedModelState(record.acpx);
      const requestedModel = options.modelId ?? getDesiredModelId(record.acpx);
      const previousEffortConfigId = effortStateFromConfigOptions(
        record.acpx?.config_options,
      )?.configId;
      const application = await applyRequestedModelAndEffortIfAdvertised({
        client,
        sessionId,
        requestedModel,
        requestedEffort: options.effort,
        models,
        configOptions: record.acpx?.config_options,
        agentCommand: record.agentCommand,
        timeoutMs: options.timeoutMs,
        onWarning: options.onModelWarning,
        onModelApplied: (modelApplication) => {
          applyRequestedModelPreferenceToRecord({
            record,
            application: modelApplication,
            requestedModel,
            initialModels: models,
            previousEffortConfigId,
            replacesEffort: true,
          });
        },
      });
      const effortConfigId = applyRequestedPreferencesToRecord({
        record,
        application,
        requestedModel,
        requestedEffort: options.effort,
        initialModels: models,
        previousEffortConfigId,
      });
      return { application, effortConfigId };
    }),
  );

  const { application, effortConfigId } = result.value;
  return {
    record: result.record,
    effortConfigId,
    response: application.effort.response ??
      application.model.response ?? {
        configOptions: structuredClone(result.record.acpx?.config_options ?? []),
      },
    resumed: result.resumed,
    loadError: result.loadError,
  };
}

export async function runSessionSetConfigOptionDirect(
  options: RunSessionSetConfigOptionDirectOptions,
): Promise<SessionSetConfigOptionResult> {
  const result = await withConnectedSession(
    buildDirectConnectedSessionOptions(options, async ({ client, sessionId, record }) => {
      const previousState = cloneSessionAcpxState(record.acpx);
      const modelConfigId = advertisedModelState(record.acpx)?.configId;
      const response = await withTimeout(
        client.setSessionConfigOption(sessionId, options.configId, options.value),
        options.timeoutMs,
      );
      applyConfigOptionsToRecord(record, response);
      const effortConfigId = effortStateFromConfigOptions(record.acpx?.config_options)?.configId;
      if (options.configId === modelConfigId) {
        setDesiredModelId(record, options.value, options.configId);
        setCurrentModelId(record, currentModelIdFromSetModelResponse(response, options.value));
        const effort = await reapplyDesiredEffortAfterModelChange({
          client,
          sessionId,
          previousState,
          nextState: record.acpx,
          timeoutMs: options.timeoutMs,
          onReconciledState: (state) => {
            record.acpx = state;
          },
        });
        record.acpx = effort.state;
        return effort.response ?? response;
      } else if (options.configId === "mode") {
        setDesiredModeId(record, options.value);
      } else if (options.configId === effortConfigId) {
        setDesiredEffort(record, options.value, options.configId);
      } else {
        setDesiredConfigOption(record, options.configId, options.value);
      }
      return response;
    }),
  );

  return {
    record: result.record,
    response: result.value,
    resumed: result.resumed,
    loadError: result.loadError,
  };
}
