import { effortStateFromConfigOptions, type SessionEffortState } from "../acp/effort-support.js";
import { modelStateFromConfigOptions, type SessionModelState } from "../acp/model-support.js";
import type { SessionAcpxState, SessionRecord } from "../types.js";
import { applyAdvertisedModelState } from "./model-state.js";

function ensureAcpxState(state: SessionAcpxState | undefined): SessionAcpxState {
  return state ?? {};
}

export function normalizeModeId(modeId: string | undefined): string | undefined {
  if (typeof modeId !== "string") {
    return undefined;
  }
  const trimmed = modeId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeModelId(modelId: string | undefined): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const trimmed = modelId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getDesiredModeId(state: SessionAcpxState | undefined): string | undefined {
  return normalizeModeId(state?.desired_mode_id);
}

export function getDesiredConfigOptions(
  state: SessionAcpxState | undefined,
): Record<string, string> {
  const desired = state?.desired_config_options;
  if (!desired) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(desired).flatMap(([configId, value]) => {
      const normalizedConfigId = normalizeModeId(configId);
      return normalizedConfigId && typeof value === "string" ? [[normalizedConfigId, value]] : [];
    }),
  );
}

export function setDesiredModeId(record: SessionRecord, modeId: string | undefined): void {
  const acpx = ensureAcpxState(record.acpx);
  const normalized = normalizeModeId(modeId);

  if (normalized) {
    acpx.desired_mode_id = normalized;
  } else {
    delete acpx.desired_mode_id;
  }

  record.acpx = acpx;
}

export function setDesiredConfigOption(
  record: SessionRecord,
  configId: string,
  value: string | undefined,
): void {
  const normalizedConfigId = normalizeModeId(configId);
  if (!normalizedConfigId || normalizedConfigId === "mode" || normalizedConfigId === "model") {
    return;
  }

  const acpx = ensureAcpxState(record.acpx);
  const desired = { ...acpx.desired_config_options };

  if (typeof value === "string") {
    desired[normalizedConfigId] = value;
  } else {
    delete desired[normalizedConfigId];
  }

  if (Object.keys(desired).length > 0) {
    acpx.desired_config_options = desired;
  } else {
    delete acpx.desired_config_options;
  }

  record.acpx = acpx;
}

export function clearDesiredConfigOption(
  state: SessionAcpxState,
  configId: string | undefined,
): void {
  const normalizedConfigId = normalizeModeId(configId);
  if (!normalizedConfigId || !state.desired_config_options) {
    return;
  }
  const desired = { ...state.desired_config_options };
  delete desired[normalizedConfigId];
  if (Object.keys(desired).length > 0) {
    state.desired_config_options = desired;
  } else {
    delete state.desired_config_options;
  }
}

export function clearDesiredEffortPreference(
  state: SessionAcpxState | undefined,
  previousConfigId?: string,
): SessionAcpxState | undefined {
  if (!state) {
    return state;
  }
  clearDesiredConfigOption(state, previousConfigId);
  clearDesiredConfigOption(state, effortStateFromConfigOptions(state.config_options)?.configId);
  const sessionOptions = { ...state.session_options };
  delete sessionOptions.effort;
  if (hasStoredSessionOptions(sessionOptions)) {
    state.session_options = sessionOptions;
  } else {
    delete state.session_options;
  }
  return state;
}

export function getDesiredModelId(state: SessionAcpxState | undefined): string | undefined {
  return normalizeModelId(state?.session_options?.model);
}

export function getDesiredEffort(state: SessionAcpxState | undefined): string | undefined {
  return normalizeModeId(state?.session_options?.effort);
}

function hasStoredSessionOptions(
  options: NonNullable<SessionAcpxState["session_options"]>,
): boolean {
  return (
    typeof options.model === "string" ||
    typeof options.effort === "string" ||
    Array.isArray(options.allowed_tools) ||
    typeof options.max_turns === "number" ||
    options.system_prompt !== undefined ||
    options.env !== undefined
  );
}

export function setDesiredModelId(
  record: SessionRecord,
  modelId: string | undefined,
  modelConfigId?: string,
): void {
  const acpx = ensureAcpxState(record.acpx);
  const normalized = normalizeModelId(modelId);
  const sessionOptions = { ...acpx.session_options };

  if (normalized) {
    sessionOptions.model = normalized;
  } else {
    delete sessionOptions.model;
  }

  if (hasStoredSessionOptions(sessionOptions)) {
    acpx.session_options = sessionOptions;
  } else {
    delete acpx.session_options;
  }

  clearDesiredConfigOption(
    acpx,
    modelConfigId ?? modelStateFromConfigOptions(acpx.config_options)?.configId,
  );
  record.acpx = acpx;
}

export function setDesiredEffort(
  record: SessionRecord,
  effort: string | undefined,
  configId?: string,
): void {
  const acpx = ensureAcpxState(record.acpx);
  const normalized = normalizeModeId(effort);
  const previousConfigId = effortStateFromConfigOptions(acpx.config_options)?.configId;
  const sessionOptions = { ...acpx.session_options };

  if (normalized) {
    sessionOptions.effort = normalized;
  } else {
    delete sessionOptions.effort;
  }

  if (hasStoredSessionOptions(sessionOptions)) {
    acpx.session_options = sessionOptions;
  } else {
    delete acpx.session_options;
  }
  record.acpx = acpx;

  if (previousConfigId && (!normalized || previousConfigId !== configId)) {
    clearDesiredConfigOption(acpx, previousConfigId);
  }
  if (configId) {
    setDesiredConfigOption(record, configId, normalized);
  }
}

export type DesiredEffortReconciliation = {
  state: SessionAcpxState;
  selection?: {
    configId: string;
    effort: string;
  };
};

function supportedEffortState(
  state: SessionAcpxState,
  desiredEffort: string,
): SessionEffortState | undefined {
  const effortState = effortStateFromConfigOptions(state.config_options);
  return effortState?.availableEfforts.some((option) => option.effort === desiredEffort)
    ? effortState
    : undefined;
}

function clearReconciledEffort(
  state: SessionAcpxState,
  configId: string | undefined,
): DesiredEffortReconciliation {
  setStoredEffort(state, undefined);
  clearDesiredConfigOption(state, configId);
  return { state };
}

function retainReconciledEffort(
  state: SessionAcpxState,
  effortState: SessionEffortState,
  desiredEffort: string,
): DesiredEffortReconciliation {
  setStoredEffort(state, desiredEffort);
  state.desired_config_options = {
    ...state.desired_config_options,
    [effortState.configId]: desiredEffort,
  };
  if (effortState.currentEffort === desiredEffort) {
    return { state };
  }
  return {
    state,
    selection: {
      configId: effortState.configId,
      effort: desiredEffort,
    },
  };
}

function setStoredEffort(state: SessionAcpxState, effort: string | undefined): void {
  const sessionOptions = { ...state.session_options };
  if (effort) {
    sessionOptions.effort = effort;
  } else {
    delete sessionOptions.effort;
  }
  if (hasStoredSessionOptions(sessionOptions)) {
    state.session_options = sessionOptions;
  } else {
    delete state.session_options;
  }
}

export function reconcileDesiredEffortForModelChange(
  previousState: SessionAcpxState | undefined,
  nextState: SessionAcpxState | undefined,
): DesiredEffortReconciliation {
  const state = structuredClone(nextState ?? {});
  const desiredEffort = getDesiredEffort(previousState);
  if (!desiredEffort) {
    return { state };
  }

  const previousConfigId = effortStateFromConfigOptions(previousState?.config_options)?.configId;
  clearDesiredConfigOption(state, previousConfigId);

  const advertisedEffortState = effortStateFromConfigOptions(state.config_options);
  const effortState = supportedEffortState(state, desiredEffort);
  if (!effortState) {
    return clearReconciledEffort(state, advertisedEffortState?.configId);
  }
  return retainReconciledEffort(state, effortState, desiredEffort);
}

export function setCurrentModelId(record: SessionRecord, modelId: string | undefined): void {
  const acpx = ensureAcpxState(record.acpx);
  const normalized = normalizeModelId(modelId);

  if (normalized) {
    acpx.current_model_id = normalized;
  } else {
    delete acpx.current_model_id;
  }

  record.acpx = acpx;
}

export function syncAdvertisedModelState(
  record: SessionRecord,
  models: SessionModelState | undefined,
): void {
  if (!models) {
    return;
  }

  const acpx = ensureAcpxState(record.acpx);
  applyAdvertisedModelState(acpx, models);
  record.acpx = acpx;
}
