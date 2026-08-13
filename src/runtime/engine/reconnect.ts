import type { AcpClient } from "../../acp/client.js";
import { effortStateFromConfigOptions } from "../../acp/effort-support.js";
import {
  extractAcpError,
  formatErrorMessage,
  isAcpQueryClosedBeforeResponseError,
  isAcpResourceNotFoundError,
} from "../../acp/error-normalization.js";
import {
  assertRequestedModelSupported,
  modelStateFromConfigOptions,
  type SessionModelState,
} from "../../acp/model-support.js";
import { InterruptedError, TimeoutError, withTimeout } from "../../async-control.js";
import {
  SessionConfigOptionReplayError,
  SessionModeReplayError,
  SessionModelReplayError,
  SessionResumeRequiredError,
} from "../../errors.js";
import { incrementPerfCounter } from "../../perf-metrics.js";
import { applyConfigOptionsToRecord } from "../../session/config-options.js";
import { cloneSessionAcpxState } from "../../session/conversation-model.js";
import {
  getDesiredConfigOptions,
  getDesiredEffort,
  getDesiredModeId,
  getDesiredModelId,
  reconcileDesiredEffortForModelChange,
  syncAdvertisedModelState,
} from "../../session/mode-preference.js";
import { clearDesiredEffortAfterUnrefreshedModelChange } from "../../session/model-application.js";
import {
  advertisedModelState,
  clearAdvertisedModelState,
  removeModelConfigOptions,
} from "../../session/model-state.js";
import type { SessionRecord, SessionResumePolicy } from "../../types.js";
import {
  applyLifecycleSnapshotToRecord,
  reconcileAgentSessionId,
  sessionHasAgentMessages,
} from "./lifecycle.js";

export type ConnectedSessionController = {
  hasActivePrompt: () => boolean;
  requestCancelActivePrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionModel: (modelId: string) => ReturnType<AcpClient["setSessionModel"]>;
  setSessionConfigOption: (
    configId: string,
    value: string,
  ) => ReturnType<AcpClient["setSessionConfigOption"]>;
};

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A connect step that could not be honoured but must not take the turn down.
 *
 * It is a value rather than a log line because the caller owns the reporting
 * surface: the CLI records it in the durable session event log where a poller
 * can find it, the runtime turns it into a turn event.
 */
export type SessionConnectWarning = {
  code: "SESSION_MODE_NOT_REAPPLIED";
  message: string;
  sessionId: string;
  modeId: string;
};

export type ConnectAndLoadSessionOptions = {
  client: AcpClient;
  record: SessionRecord;
  resumePolicy?: SessionResumePolicy;
  timeoutMs?: number;
  verbose?: boolean;
  suppressWarnings?: boolean;
  activeController: ConnectedSessionController;
  onClientAvailable?: (controller: ConnectedSessionController) => void;
  onConnectedRecord?: (record: SessionRecord) => void;
  onSessionIdResolved?: (sessionId: string) => void;
  onWarning?: (warning: SessionConnectWarning) => void;
};

export type ConnectAndLoadSessionResult = {
  sessionId: string;
  agentSessionId?: string;
  resumed: boolean;
  loadError?: string;
};

const SESSION_LOAD_UNSUPPORTED_CODES = new Set([-32601, -32602]);

function shouldFallbackToNewSession(error: unknown, record: SessionRecord): boolean {
  if (isHardReconnectFailure(error)) {
    return false;
  }
  const acp = extractAcpError(error);
  if (isAcpResourceNotFoundError(error) || isUnsupportedSessionLoadAcpError(acp)) {
    return true;
  }

  return !sessionHasAgentMessages(record) && isFallbackSafeEmptySessionError(error, acp);
}

function isHardReconnectFailure(error: unknown): boolean {
  return error instanceof TimeoutError || error instanceof InterruptedError;
}

function isUnsupportedSessionLoadAcpError(acp: ReturnType<typeof extractAcpError>): boolean {
  return !!acp && SESSION_LOAD_UNSUPPORTED_CODES.has(acp.code);
}

function isFallbackSafeEmptySessionError(
  error: unknown,
  acp: ReturnType<typeof extractAcpError>,
): boolean {
  return isAcpQueryClosedBeforeResponseError(error) || acp?.code === -32603;
}

function requiresSameSession(resumePolicy: SessionResumePolicy | undefined): boolean {
  return resumePolicy === "same-session-only";
}

function makeSessionResumeRequiredError(params: {
  record: SessionRecord;
  reason: string;
  cause?: unknown;
}): SessionResumeRequiredError {
  return new SessionResumeRequiredError(
    `Persistent ACP session ${params.record.acpSessionId} could not be resumed: ${params.reason}`,
    {
      cause: params.cause instanceof Error ? params.cause : undefined,
    },
  );
}

async function replayDesiredMode(params: {
  client: AcpClient;
  sessionId: string;
  desiredModeId: string | undefined;
  previousSessionId: string;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<void> {
  if (!params.desiredModeId) {
    return;
  }

  try {
    await withTimeout(
      params.client.setSessionMode(params.sessionId, params.desiredModeId),
      params.timeoutMs,
    );
    if (params.verbose) {
      process.stderr.write(
        `[acpx] replayed desired mode ${params.desiredModeId} on fresh ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`,
      );
    }
  } catch (error) {
    throw new SessionModeReplayError(
      `Failed to replay saved session mode ${params.desiredModeId} on fresh ACP session ${params.sessionId}: ${formatErrorMessage(error)}`,
      {
        cause: error instanceof Error ? error : undefined,
        retryable: true,
      },
    );
  }
}

/**
 * True when this connect bound the record to an adapter session it neither
 * created nor was already holding open.
 *
 * A session acpx just created has had its preferences replayed already, and a
 * session this client still holds open is not a new binding at all — asserting
 * the mode there would add a `session/set_mode` to every turn and would
 * override a mode the agent itself moved to mid-conversation.
 */
function boundToUncreatedAdapterSession(
  createdFreshSession: boolean,
  reusingLoadedSession: boolean,
): boolean {
  return !createdFreshSession && !reusingLoadedSession;
}

/**
 * Re-assert the saved mode on an adapter session acpx bound but did not create.
 *
 * `session/resume` and `session/load` return the record's own session id, but
 * behind it the adapter has built a *new* session — after a queue-owner
 * restart, an agent process death, or a resume that fell back to load. That
 * session starts at the adapter's default mode, and both defaults in wide use
 * (claude `auto`, codex `agent`) let the agent answer its own permission
 * prompts. A session an operator deliberately put in `plan` or `read-only`
 * would silently regain self-approval. The mode is a security posture, so it
 * is re-applied on every binding rather than only on the ones acpx created.
 *
 * Best effort by design: an adapter that has retired the saved mode id must
 * not take the turn down with it. It must not pass for applied either, so the
 * refusal is reported to the caller and the saved preference is kept for the
 * next binding.
 */
async function reapplyModeOnBoundSession(params: {
  client: AcpClient;
  sessionId: string;
  desiredModeId: string | undefined;
  timeoutMs?: number;
  verbose?: boolean;
  onWarning?: (warning: SessionConnectWarning) => void;
}): Promise<void> {
  if (!params.desiredModeId) {
    return;
  }

  try {
    await withTimeout(
      params.client.setSessionMode(params.sessionId, params.desiredModeId),
      params.timeoutMs,
    );
    if (params.verbose) {
      process.stderr.write(
        `[acpx] re-applied saved mode ${params.desiredModeId} on rebound ACP session ${params.sessionId}\n`,
      );
    }
  } catch (error) {
    // An interrupt is the operator stopping the turn, not the adapter refusing
    // a mode, and swallowing it would run the prompt they just cancelled.
    if (error instanceof InterruptedError) {
      throw error;
    }
    const message = `Saved session mode ${params.desiredModeId} was not re-applied to ACP session ${params.sessionId} and is not in force: ${formatErrorMessage(error)}`;
    params.onWarning?.({
      code: "SESSION_MODE_NOT_REAPPLIED",
      message,
      sessionId: params.sessionId,
      modeId: params.desiredModeId,
    });
    if (params.verbose) {
      process.stderr.write(`[acpx] warning: ${message}\n`);
    }
  }
}

function effortSelectionForBoundSession(params: {
  record: SessionRecord;
  originalAcpx: SessionRecord["acpx"];
  configOptionsPresent: boolean;
}): { configId: string; effort: string } | undefined {
  const desiredEffort = getDesiredEffort(params.record.acpx);
  if (!desiredEffort) {
    return undefined;
  }

  if (params.configOptionsPresent) {
    const reconciliation = reconcileDesiredEffortForModelChange(
      params.originalAcpx,
      params.record.acpx,
    );
    params.record.acpx = reconciliation.state;
    return reconciliation.selection;
  }

  const previousEffort = effortStateFromConfigOptions(params.originalAcpx?.config_options);
  if (
    !previousEffort ||
    !previousEffort.availableEfforts.some((option) => option.effort === desiredEffort)
  ) {
    return undefined;
  }
  return { configId: previousEffort.configId, effort: desiredEffort };
}

function effortConfigId(state: SessionRecord["acpx"]): string | undefined {
  return effortStateFromConfigOptions(state?.config_options)?.configId;
}

async function reapplyEffortOnBoundSession(params: {
  client: AcpClient;
  record: SessionRecord;
  sessionId: string;
  originalSessionId: string;
  originalAcpx: SessionRecord["acpx"];
  configOptionsPresent: boolean;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<ConfigReplayResult> {
  const selection = effortSelectionForBoundSession(params);
  if (!selection) {
    return { replayed: false };
  }

  try {
    const replay = await replayDesiredConfigOptions({
      client: params.client,
      record: params.record,
      sessionId: params.sessionId,
      desiredConfigOptions: { [selection.configId]: selection.effort },
      previousSessionId: params.originalSessionId,
      timeoutMs: params.timeoutMs,
      verbose: params.verbose,
    });
    params.record.acpx = reconcileDesiredEffortForModelChange(
      params.originalAcpx,
      params.record.acpx,
    ).state;
    return replay;
  } catch (error) {
    params.record.acpx = cloneSessionAcpxState(params.originalAcpx);
    throw error;
  }
}

function clearEffortAfterUnrefreshedModelReplay(params: {
  record: SessionRecord;
  response: Awaited<ReturnType<AcpClient["setSessionModel"]>>;
  models: SessionModelState | undefined;
  desiredModelId: string;
  previousEffortConfigId?: string;
}): void {
  params.record.acpx = clearDesiredEffortAfterUnrefreshedModelChange({
    state: params.record.acpx,
    modelResponse: params.response,
    previousModelId: params.models?.currentModelId,
    requestedModelId: params.desiredModelId,
    previousEffortConfigId: params.previousEffortConfigId,
  });
}

function shouldSkipModelReplay(
  models: SessionModelState | undefined,
  desiredModelId: string,
  force: boolean | undefined,
): boolean {
  return !models || (!force && models.currentModelId === desiredModelId);
}

async function replayDesiredModel(params: {
  client: AcpClient;
  sessionId: string;
  desiredModelId: string | undefined;
  previousSessionId: string;
  record: SessionRecord;
  models: import("../../acp/client.js").SessionLoadResult["models"] | undefined;
  previousEffortConfigId?: string;
  force?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  suppressWarnings?: boolean;
}): Promise<ModelReplayResult> {
  if (!params.desiredModelId) {
    return { replayed: false };
  }

  try {
    const warning = assertRequestedModelSupported({
      requestedModel: params.desiredModelId,
      models: params.models,
      agentCommand: params.record.agentCommand,
      context: "replay",
    });
    emitModelSupportWarning(warning, params.suppressWarnings);
    if (shouldSkipModelReplay(params.models, params.desiredModelId, params.force)) {
      return { replayed: false };
    }
    const replayModels = params.models as SessionModelState;
    const response = await withTimeout(
      params.client.setSessionModel(params.sessionId, params.desiredModelId, replayModels),
      params.timeoutMs,
    );
    applyConfigOptionsToRecord(params.record, response);
    clearEffortAfterUnrefreshedModelReplay({
      record: params.record,
      response,
      models: replayModels,
      desiredModelId: params.desiredModelId,
      previousEffortConfigId: params.previousEffortConfigId,
    });
    const models = response
      ? modelStateFromConfigOptions(response.configOptions)
      : { ...replayModels, currentModelId: params.desiredModelId };
    if (params.verbose) {
      process.stderr.write(
        `[acpx] replayed desired model ${params.desiredModelId} on ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`,
      );
    }
    return {
      replayed: true,
      models,
      configOptionsPresent: response !== undefined,
    };
  } catch (error) {
    throw new SessionModelReplayError(
      `Failed to replay saved session model ${params.desiredModelId} on ACP session ${params.sessionId}: ${formatErrorMessage(error)}`,
      {
        cause: error instanceof Error ? error : undefined,
        retryable: true,
      },
    );
  }
}

function emitModelSupportWarning(warning: string | undefined, suppressWarnings?: boolean): void {
  if (warning && !suppressWarnings) {
    process.stderr.write(`[acpx] warning: ${warning}\n`);
  }
}

type ModelReplayResult =
  | { replayed: false }
  | {
      replayed: true;
      models: SessionModelState | undefined;
      configOptionsPresent: boolean;
    };

type ConfigReplayResult =
  | { replayed: false }
  | {
      replayed: true;
      models: SessionModelState | undefined;
    };

type FreshPreferenceReplayResult = {
  modelReplay: ModelReplayResult;
  configReplay: ConfigReplayResult;
};

function withConfigReplay(
  replay: FreshPreferenceReplayResult,
  configReplay: ConfigReplayResult,
): FreshPreferenceReplayResult {
  return configReplay.replayed ? { ...replay, configReplay } : replay;
}

function configOptionsPresentAfterModelReplay(
  initiallyPresent: boolean,
  modelReplay: ModelReplayResult,
): boolean {
  return initiallyPresent || (modelReplay.replayed && modelReplay.configOptionsPresent);
}

function reconnectMetadataIsSparse(loadState: RuntimeSessionLoadState): boolean {
  return !loadState.configOptionsPresent && !loadState.legacyModelMetadataPresent;
}

function modelsForBoundReplay(
  loadState: RuntimeSessionLoadState,
  record: SessionRecord,
): SessionModelState | undefined {
  if (loadState.configOptionsPresent || loadState.legacyModelMetadataPresent) {
    return loadState.sessionModels;
  }
  return advertisedModelState(record.acpx);
}

async function replayDesiredConfigOptions(params: {
  client: AcpClient;
  record: SessionRecord;
  sessionId: string;
  desiredConfigOptions: Record<string, string>;
  previousSessionId: string;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<ConfigReplayResult> {
  let result: ConfigReplayResult = { replayed: false };
  for (const [configId, value] of Object.entries(params.desiredConfigOptions)) {
    try {
      const response = await withTimeout(
        params.client.setSessionConfigOption(params.sessionId, configId, value),
        params.timeoutMs,
      );
      applyConfigOptionsToRecord(params.record, response);
      result = {
        replayed: true,
        models: modelStateFromConfigOptions(response.configOptions),
      };
      if (params.verbose) {
        process.stderr.write(
          `[acpx] replayed desired config option ${configId} on ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`,
        );
      }
    } catch (error) {
      throw new SessionConfigOptionReplayError(
        `Failed to replay saved session config option ${configId} on ACP session ${params.sessionId}: ${formatErrorMessage(error)}`,
        {
          cause: error instanceof Error ? error : undefined,
          retryable: true,
        },
      );
    }
  }
  return result;
}

function restoreOriginalSessionState(params: {
  record: SessionRecord;
  sessionId: string;
  agentSessionId: string | undefined;
}): void {
  params.record.acpSessionId = params.sessionId;
  params.record.agentSessionId = params.agentSessionId;
}

export async function connectAndLoadSession(
  options: ConnectAndLoadSessionOptions,
): Promise<ConnectAndLoadSessionResult> {
  const record = options.record;
  const client = options.client;
  const sameSessionOnly = requiresSameSession(options.resumePolicy) || Boolean(record.importedFrom);
  const originalSessionId = record.acpSessionId;
  const originalAgentSessionId = record.agentSessionId;
  const originalAcpx = cloneSessionAcpxState(record.acpx);
  const desiredModeId = getDesiredModeId(record.acpx);
  const desiredModelId = getDesiredModelId(record.acpx);
  const storedProcessAlive = isProcessAlive(record.pid);
  const shouldReconnect = Boolean(record.pid) && !storedProcessAlive;

  logReconnectAttempt(record, storedProcessAlive, shouldReconnect, options.verbose);

  const reusingLoadedSession = client.hasReusableSession(record.acpSessionId);
  if (reusingLoadedSession) {
    incrementPerfCounter("runtime.connect_and_load.reused_session");
  } else {
    await withTimeout(client.start(), options.timeoutMs);
  }
  applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
  record.closed = false;
  record.closedAt = undefined;
  options.onConnectedRecord?.(record);

  let resumed = false;
  let loadError: string | undefined;
  let sessionId = record.acpSessionId;
  let createdFreshSession = false;
  let pendingAgentSessionId = record.agentSessionId;
  let sessionModels: import("../../acp/client.js").SessionLoadResult["models"];

  const loadState = await loadOrCreateRuntimeSession({
    client,
    record,
    reusingLoadedSession,
    sameSessionOnly,
    timeoutMs: options.timeoutMs,
  });
  resumed = loadState.resumed;
  loadError = loadState.loadError;
  sessionId = loadState.sessionId;
  createdFreshSession = loadState.createdFreshSession;
  pendingAgentSessionId = loadState.pendingAgentSessionId;
  sessionModels = loadState.sessionModels;

  let preferenceReplay = await replayFreshSessionPreferences({
    client,
    record,
    createdFreshSession,
    sessionId,
    pendingAgentSessionId,
    originalSessionId,
    originalAgentSessionId,
    originalAcpx,
    desiredModeId,
    desiredModelId,
    sessionModels,
    configOptionsPresent: loadState.configOptionsPresent,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
    suppressWarnings: options.suppressWarnings,
  });

  if (boundToUncreatedAdapterSession(createdFreshSession, reusingLoadedSession)) {
    await reapplyModeOnBoundSession({
      client,
      sessionId,
      desiredModeId,
      timeoutMs: options.timeoutMs,
      verbose: options.verbose,
      onWarning: options.onWarning,
    });
    const modelReplay = await replayDesiredModel({
      client,
      sessionId,
      desiredModelId,
      previousSessionId: originalSessionId,
      record,
      models: modelsForBoundReplay(loadState, record),
      previousEffortConfigId: effortConfigId(originalAcpx),
      force: reconnectMetadataIsSparse(loadState),
      timeoutMs: options.timeoutMs,
      verbose: options.verbose,
      suppressWarnings: options.suppressWarnings,
    });
    const effortReplay = await reapplyEffortOnBoundSession({
      client,
      record,
      sessionId,
      originalSessionId,
      originalAcpx,
      configOptionsPresent: configOptionsPresentAfterModelReplay(
        loadState.configOptionsPresent,
        modelReplay,
      ),
      timeoutMs: options.timeoutMs,
      verbose: options.verbose,
    });
    preferenceReplay = withConfigReplay({ ...preferenceReplay, modelReplay }, effortReplay);
  }

  applyReconnectedModelState(
    record,
    resolveModelsAfterReplay(preferenceReplay, sessionModels),
    resolveConfigOptionsPresenceAfterReplay(preferenceReplay, loadState.configOptionsPresent),
    loadState.legacyModelMetadataPresent,
    createdFreshSession,
  );

  options.onSessionIdResolved?.(sessionId);
  options.onClientAvailable?.(options.activeController);

  return {
    sessionId,
    agentSessionId: record.agentSessionId,
    resumed,
    loadError,
  };
}

function resolveModelsAfterReplay(
  replay: FreshPreferenceReplayResult,
  initialModels: SessionModelState | undefined,
): SessionModelState | undefined {
  if (replay.configReplay.replayed) {
    return (
      replay.configReplay.models ??
      preserveLegacyModels(replay.modelReplay.replayed ? replay.modelReplay.models : initialModels)
    );
  }
  return replay.modelReplay.replayed ? replay.modelReplay.models : initialModels;
}

function preserveLegacyModels(
  models: SessionModelState | undefined,
): SessionModelState | undefined {
  return models && !models.configId ? models : undefined;
}

function resolveConfigOptionsPresenceAfterReplay(
  replay: FreshPreferenceReplayResult,
  initiallyPresent: boolean,
): boolean {
  return (
    initiallyPresent ||
    replay.configReplay.replayed ||
    (replay.modelReplay.replayed && replay.modelReplay.configOptionsPresent)
  );
}

function applyReconnectedModelState(
  record: SessionRecord,
  sessionModels: import("../../acp/client.js").SessionLoadResult["models"],
  configOptionsPresent: boolean,
  legacyModelMetadataPresent: boolean,
  createdFreshSession: boolean,
): void {
  clearOmittedFreshSessionConfigOptions(record, createdFreshSession, configOptionsPresent);
  if (sessionModels) {
    if (legacyModelMetadataPresent && !sessionModels.configId && record.acpx) {
      removeModelConfigOptions(record.acpx);
    }
    syncAdvertisedModelState(record, sessionModels);
  } else {
    clearRemovedModelState(record, legacyModelMetadataPresent || createdFreshSession);
  }
}

function clearOmittedFreshSessionConfigOptions(
  record: SessionRecord,
  createdFreshSession: boolean,
  configOptionsPresent: boolean,
): void {
  if (createdFreshSession && !configOptionsPresent && record.acpx) {
    delete record.acpx.config_options;
  }
}

function clearRemovedModelState(record: SessionRecord, shouldClear: boolean): void {
  if (shouldClear && record.acpx) {
    clearAdvertisedModelState(record.acpx);
  }
}

function logReconnectAttempt(
  record: SessionRecord,
  storedProcessAlive: boolean,
  shouldReconnect: boolean,
  verbose: boolean | undefined,
): void {
  if (!verbose) {
    return;
  }
  if (storedProcessAlive) {
    process.stderr.write(
      `[acpx] saved session pid ${record.pid} is running; reconnecting to saved ACP session\n`,
    );
    return;
  }
  if (shouldReconnect) {
    process.stderr.write(
      `[acpx] saved session pid ${record.pid} is dead; respawning agent and attempting session reconnect\n`,
    );
  }
}

async function replayFreshSessionPreferences(params: {
  client: AcpClient;
  record: SessionRecord;
  createdFreshSession: boolean;
  sessionId: string;
  pendingAgentSessionId: string | undefined;
  originalSessionId: string;
  originalAgentSessionId: string | undefined;
  originalAcpx: SessionRecord["acpx"];
  desiredModeId: string | undefined;
  desiredModelId: string | undefined;
  sessionModels: import("../../acp/client.js").SessionLoadResult["models"];
  configOptionsPresent: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  suppressWarnings?: boolean;
}): Promise<FreshPreferenceReplayResult> {
  if (!params.createdFreshSession) {
    return {
      modelReplay: { replayed: false },
      configReplay: { replayed: false },
    };
  }

  let modelReplay: ModelReplayResult = { replayed: false };
  let configReplay: ConfigReplayResult = { replayed: false };
  try {
    await replayDesiredMode({
      client: params.client,
      sessionId: params.sessionId,
      desiredModeId: params.desiredModeId,
      previousSessionId: params.originalSessionId,
      timeoutMs: params.timeoutMs,
      verbose: params.verbose,
    });
    modelReplay = await replayDesiredModel({
      client: params.client,
      sessionId: params.sessionId,
      desiredModelId: params.desiredModelId,
      previousSessionId: params.originalSessionId,
      record: params.record,
      models: params.sessionModels,
      previousEffortConfigId: effortConfigId(params.originalAcpx),
      timeoutMs: params.timeoutMs,
      verbose: params.verbose,
      suppressWarnings: params.suppressWarnings,
    });
    if (params.configOptionsPresent || (modelReplay.replayed && modelReplay.configOptionsPresent)) {
      params.record.acpx = reconcileDesiredEffortForModelChange(
        params.originalAcpx,
        params.record.acpx,
      ).state;
    }
    configReplay = await replayDesiredConfigOptions({
      client: params.client,
      record: params.record,
      sessionId: params.sessionId,
      desiredConfigOptions: getDesiredConfigOptions(params.record.acpx),
      previousSessionId: params.originalSessionId,
      timeoutMs: params.timeoutMs,
      verbose: params.verbose,
    });
  } catch (error) {
    restoreOriginalSessionState({
      record: params.record,
      sessionId: params.originalSessionId,
      agentSessionId: params.originalAgentSessionId,
    });
    params.record.acpx = cloneSessionAcpxState(params.originalAcpx);
    if (params.verbose) {
      process.stderr.write(`[acpx] ${formatErrorMessage(error)}\n`);
    }
    throw error;
  }

  params.record.acpSessionId = params.sessionId;
  reconcileAgentSessionId(params.record, params.pendingAgentSessionId);
  return { modelReplay, configReplay };
}

type RuntimeSessionLoadState = {
  sessionId: string;
  pendingAgentSessionId: string | undefined;
  sessionModels: import("../../acp/client.js").SessionLoadResult["models"];
  configOptionsPresent: boolean;
  legacyModelMetadataPresent: boolean;
  resumed: boolean;
  createdFreshSession: boolean;
  loadError?: string;
};

async function loadOrCreateRuntimeSession(params: {
  client: AcpClient;
  record: SessionRecord;
  reusingLoadedSession: boolean;
  sameSessionOnly: boolean;
  timeoutMs?: number;
}): Promise<RuntimeSessionLoadState> {
  if (params.reusingLoadedSession) {
    return {
      sessionId: params.record.acpSessionId,
      pendingAgentSessionId: params.record.agentSessionId,
      sessionModels: undefined,
      configOptionsPresent: false,
      legacyModelMetadataPresent: false,
      resumed: true,
      createdFreshSession: false,
    };
  }

  if (params.client.supportsResumeSession()) {
    return await resumeRuntimeSession(params);
  }

  if (params.client.supportsLoadSession()) {
    return await loadRuntimeSession(params);
  }

  if (params.sameSessionOnly) {
    throw makeSessionResumeRequiredError({
      record: params.record,
      reason: "agent does not support session/resume or session/load",
    });
  }

  return await createFreshRuntimeSession(params.client, params.record, params.timeoutMs);
}

async function resumeRuntimeSession(params: {
  client: AcpClient;
  record: SessionRecord;
  sameSessionOnly: boolean;
  timeoutMs?: number;
}): Promise<RuntimeSessionLoadState> {
  try {
    const resumeResult = await withTimeout(
      params.client.resumeSession(params.record.acpSessionId, params.record.cwd),
      params.timeoutMs,
    );
    reconcileAgentSessionId(params.record, resumeResult.agentSessionId);
    applyConfigOptionsToRecord(params.record, resumeResult);
    return {
      sessionId: params.record.acpSessionId,
      pendingAgentSessionId: params.record.agentSessionId,
      sessionModels: resumeResult.models,
      configOptionsPresent: resumeResult.configOptionsPresent,
      legacyModelMetadataPresent: resumeResult.legacyModelMetadataPresent,
      resumed: true,
      createdFreshSession: false,
    };
  } catch (error) {
    return await recoverRuntimeSessionLoadFailure(params, error);
  }
}

async function loadRuntimeSession(params: {
  client: AcpClient;
  record: SessionRecord;
  sameSessionOnly: boolean;
  timeoutMs?: number;
}): Promise<RuntimeSessionLoadState> {
  try {
    const loadResult = await withTimeout(
      params.client.loadSessionWithOptions(params.record.acpSessionId, params.record.cwd, {
        suppressReplayUpdates: true,
      }),
      params.timeoutMs,
    );
    reconcileAgentSessionId(params.record, loadResult.agentSessionId);
    applyConfigOptionsToRecord(params.record, loadResult);
    return {
      sessionId: params.record.acpSessionId,
      pendingAgentSessionId: params.record.agentSessionId,
      sessionModels: loadResult.models,
      configOptionsPresent: loadResult.configOptionsPresent,
      legacyModelMetadataPresent: loadResult.legacyModelMetadataPresent,
      resumed: true,
      createdFreshSession: false,
    };
  } catch (error) {
    return await recoverRuntimeSessionLoadFailure(params, error);
  }
}

async function recoverRuntimeSessionLoadFailure(
  params: {
    client: AcpClient;
    record: SessionRecord;
    sameSessionOnly: boolean;
    timeoutMs?: number;
  },
  error: unknown,
): Promise<RuntimeSessionLoadState> {
  const loadError = formatErrorMessage(error);
  if (params.sameSessionOnly) {
    throw makeSessionResumeRequiredError({
      record: params.record,
      reason: loadError,
      cause: error,
    });
  }
  if (!shouldFallbackToNewSession(error, params.record)) {
    throw error;
  }
  return {
    ...(await createFreshRuntimeSession(params.client, params.record, params.timeoutMs)),
    loadError,
  };
}

async function createFreshRuntimeSession(
  client: AcpClient,
  record: SessionRecord,
  timeoutMs: number | undefined,
): Promise<RuntimeSessionLoadState> {
  const createdSession = await withTimeout(client.createSession(record.cwd), timeoutMs);
  applyConfigOptionsToRecord(record, createdSession);
  return {
    sessionId: createdSession.sessionId,
    pendingAgentSessionId: createdSession.agentSessionId,
    sessionModels: createdSession.models,
    configOptionsPresent: createdSession.configOptionsPresent,
    legacyModelMetadataPresent: createdSession.legacyModelMetadataPresent,
    resumed: false,
    createdFreshSession: true,
  };
}
