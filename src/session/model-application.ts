import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import type { AcpClient, SessionCreateResult } from "../acp/client.js";
import {
  assertRequestedEffortSupported,
  RequestedEffortUnsupportedError,
} from "../acp/effort-support.js";
import {
  assertRequestedModelSupported,
  modelStateFromConfigOptions,
} from "../acp/model-support.js";
import { withTimeout } from "../async-control.js";
import type { SessionAcpxState, SessionRecord } from "../types.js";
import { applyConfigOptionsToRecord, applyConfigOptionsToState } from "./config-options.js";
import {
  clearDesiredConfigOption,
  clearDesiredEffortPreference,
  reconcileDesiredEffortForModelChange,
  setCurrentModelId,
  setDesiredEffort,
  setDesiredModelId,
} from "./mode-preference.js";

export function clearDesiredEffortAfterUnrefreshedModelChange(params: {
  state: SessionAcpxState | undefined;
  modelResponse: SetSessionConfigOptionResponse | undefined;
  previousModelId: string | undefined;
  requestedModelId: string | undefined;
  previousEffortConfigId?: string;
}): SessionAcpxState | undefined {
  const requestedModelId = params.requestedModelId?.trim();
  if (
    params.modelResponse ||
    !requestedModelId ||
    params.previousModelId?.trim() === requestedModelId
  ) {
    return params.state;
  }
  return clearDesiredEffortPreference(params.state, params.previousEffortConfigId);
}

export function currentModelIdFromSetModelResponse(
  response: SetSessionConfigOptionResponse | undefined,
  fallbackModelId: string | undefined,
): string | undefined {
  return modelStateFromConfigOptions(response?.configOptions)?.currentModelId ?? fallbackModelId;
}

export async function reapplyDesiredEffortAfterModelChange(params: {
  client: AcpClient;
  sessionId: string;
  previousState: SessionAcpxState | undefined;
  nextState: SessionAcpxState | undefined;
  timeoutMs?: number;
  onReconciledState?: (state: SessionAcpxState) => void | Promise<void>;
}): Promise<{
  state: SessionAcpxState;
  response?: SetSessionConfigOptionResponse;
}> {
  const reconciliation = reconcileDesiredEffortForModelChange(
    params.previousState,
    params.nextState,
  );
  await params.onReconciledState?.(reconciliation.state);
  if (!reconciliation.selection) {
    return { state: reconciliation.state };
  }

  const response = await withTimeout(
    params.client.setSessionConfigOption(
      params.sessionId,
      reconciliation.selection.configId,
      reconciliation.selection.effort,
    ),
    params.timeoutMs,
  );
  return {
    state: applyConfigOptionsToState(reconciliation.state, response.configOptions),
    response,
  };
}

export async function applyRequestedModelIfAdvertised(params: {
  client: AcpClient;
  sessionId: string;
  requestedModel: string | undefined;
  models: SessionCreateResult["models"];
  agentCommand?: string;
  timeoutMs?: number;
  onWarning?: (message: string) => void;
}): Promise<{
  applied: boolean;
  response?: SetSessionConfigOptionResponse;
}> {
  const requestedModel =
    typeof params.requestedModel === "string" ? params.requestedModel.trim() : "";
  if (!requestedModel) {
    return { applied: false };
  }
  const warning = assertRequestedModelSupported({
    requestedModel,
    models: params.models,
    agentCommand: params.agentCommand,
    context: "apply",
  });
  if (warning) {
    params.onWarning?.(warning);
  }
  if (!params.models) {
    return { applied: false };
  }
  if (params.models.currentModelId === requestedModel) {
    return { applied: true };
  }

  const response = await withTimeout(
    params.client.setSessionModel(params.sessionId, requestedModel, params.models),
    params.timeoutMs,
  );
  return { applied: true, response };
}

export async function applyRequestedEffortIfAdvertised(params: {
  client: AcpClient;
  sessionId: string;
  requestedEffort: string | undefined;
  configOptions: unknown;
  modelId?: string;
  timeoutMs?: number;
}): Promise<{
  applied: boolean;
  configId?: string;
  response?: SetSessionConfigOptionResponse;
}> {
  const requestedEffort =
    typeof params.requestedEffort === "string" ? params.requestedEffort.trim() : "";
  if (!requestedEffort) {
    return { applied: false };
  }

  const state = assertRequestedEffortSupported({
    requestedEffort,
    configOptions: params.configOptions,
    modelId: params.modelId,
  });
  if (state.currentEffort === requestedEffort) {
    return { applied: true, configId: state.configId };
  }

  const response = await withTimeout(
    params.client.setSessionConfigOption(params.sessionId, state.configId, requestedEffort),
    params.timeoutMs,
  );
  return { applied: true, configId: state.configId, response };
}

async function notifyRequestedModelApplied(
  application: Awaited<ReturnType<typeof applyRequestedModelIfAdvertised>>,
  callback:
    | ((
        application: Awaited<ReturnType<typeof applyRequestedModelIfAdvertised>>,
      ) => void | Promise<void>)
    | undefined,
): Promise<void> {
  if (application.applied && callback) {
    await callback(application);
  }
}

function assertCombinedLegacyModelAndEffortSupported(params: {
  requestedModel: string | undefined;
  requestedEffort: string | undefined;
  models: SessionCreateResult["models"];
}): void {
  const requestedModel = params.requestedModel?.trim();
  const requestedEffort = params.requestedEffort?.trim();
  if (
    !requestedModel ||
    !requestedEffort ||
    !params.models ||
    params.models.configId ||
    params.models.currentModelId === requestedModel
  ) {
    return;
  }

  throw new RequestedEffortUnsupportedError(
    `Cannot apply --model "${requestedModel}" with --effort "${requestedEffort}": this ACP agent only exposes legacy model switching and cannot advertise refreshed effort values before the model changes. Set the model first, then apply effort separately.`,
    "invalid-capability",
  );
}

export async function applyRequestedModelAndEffortIfAdvertised(params: {
  client: AcpClient;
  sessionId: string;
  requestedModel: string | undefined;
  requestedEffort: string | undefined;
  models: SessionCreateResult["models"];
  configOptions: unknown;
  agentCommand?: string;
  timeoutMs?: number;
  onWarning?: (message: string) => void;
  onModelApplied?: (
    application: Awaited<ReturnType<typeof applyRequestedModelIfAdvertised>>,
  ) => void | Promise<void>;
}): Promise<{
  model: Awaited<ReturnType<typeof applyRequestedModelIfAdvertised>>;
  effort: Awaited<ReturnType<typeof applyRequestedEffortIfAdvertised>>;
}> {
  assertCombinedLegacyModelAndEffortSupported(params);
  const model = await applyRequestedModelIfAdvertised({
    client: params.client,
    sessionId: params.sessionId,
    requestedModel: params.requestedModel,
    models: params.models,
    agentCommand: params.agentCommand,
    timeoutMs: params.timeoutMs,
    onWarning: params.onWarning,
  });
  const configOptions = model.response?.configOptions ?? params.configOptions;
  await notifyRequestedModelApplied(model, params.onModelApplied);
  const selectedModel =
    modelStateFromConfigOptions(configOptions)?.currentModelId ??
    params.requestedModel ??
    params.models?.currentModelId;
  const effort = await applyRequestedEffortIfAdvertised({
    client: params.client,
    sessionId: params.sessionId,
    requestedEffort: params.requestedEffort,
    configOptions,
    modelId: selectedModel,
    timeoutMs: params.timeoutMs,
  });
  return { model, effort };
}

export function applyRequestedModelPreferenceToRecord(params: {
  record: SessionRecord;
  application: Awaited<ReturnType<typeof applyRequestedModelIfAdvertised>>;
  requestedModel: string | undefined;
  initialModels: SessionCreateResult["models"];
  previousEffortConfigId?: string;
  replacesEffort?: boolean;
}): void {
  applyConfigOptionsToRecord(params.record, params.application.response);
  if (!params.application.applied) {
    return;
  }

  setDesiredModelId(params.record, params.requestedModel, params.initialModels?.configId);
  setCurrentModelId(
    params.record,
    currentModelIdFromSetModelResponse(params.application.response, params.requestedModel),
  );
  params.record.acpx = clearDesiredEffortAfterUnrefreshedModelChange({
    state: params.record.acpx,
    modelResponse: params.application.response,
    previousModelId: params.initialModels?.currentModelId,
    requestedModelId: params.requestedModel,
    previousEffortConfigId: params.previousEffortConfigId,
  });
  if (!params.replacesEffort || params.initialModels?.currentModelId === params.requestedModel) {
    return;
  }

  if (params.record.acpx) {
    clearDesiredConfigOption(params.record.acpx, params.previousEffortConfigId);
  }
  setDesiredEffort(params.record, undefined);
}

export function applyRequestedPreferencesToRecord(params: {
  record: SessionRecord;
  application: Awaited<ReturnType<typeof applyRequestedModelAndEffortIfAdvertised>>;
  requestedModel: string | undefined;
  requestedEffort: string;
  initialModels: SessionCreateResult["models"];
  previousEffortConfigId: string | undefined;
}): string {
  applyRequestedModelPreferenceToRecord({
    record: params.record,
    application: params.application.model,
    requestedModel: params.requestedModel,
    initialModels: params.initialModels,
    previousEffortConfigId: params.previousEffortConfigId,
    replacesEffort: true,
  });
  applyConfigOptionsToRecord(params.record, params.application.effort.response);

  const effortConfigId = params.application.effort.configId;
  if (!effortConfigId) {
    throw new Error("Applied effort did not resolve to an ACP session config option");
  }
  if (
    params.previousEffortConfigId &&
    params.previousEffortConfigId !== effortConfigId &&
    params.record.acpx
  ) {
    clearDesiredConfigOption(params.record.acpx, params.previousEffortConfigId);
  }
  setDesiredEffort(params.record, params.requestedEffort, effortConfigId);
  return effortConfigId;
}
