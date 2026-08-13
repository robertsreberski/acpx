import { splitCommandLine } from "../../acp/client-process.js";
import { AcpClient } from "../../acp/client.js";
import { isCodexAcpCommand } from "../../acp/codex-compat.js";
import { effortStateFromConfigOptions } from "../../acp/effort-support.js";
import {
  extractAcpError,
  formatErrorMessage,
  isRetryablePromptError,
  normalizeOutputError,
} from "../../acp/error-normalization.js";
import { modelStateFromConfigOptions } from "../../acp/model-support.js";
import { InterruptedError, withInterrupt, withTimeout } from "../../async-control.js";
export { InterruptedError, TimeoutError } from "../../async-control.js";
import { formatPerfMetric, measurePerf, startPerfTimer } from "../../perf-metrics.js";
import { permissionDenialTakesPrecedence, permissionStatsDelta } from "../../permissions.js";
import { textPrompt } from "../../prompt-content.js";
import {
  applyConversation,
  applyLifecycleSnapshotToRecord,
} from "../../runtime/engine/lifecycle.js";
import { runPromptTurn } from "../../runtime/engine/prompt-turn.js";
import {
  canCreateFirstPromptProviderSession,
  connectAndLoadSession,
} from "../../runtime/engine/reconnect.js";
import {
  mergeSessionOptions,
  sessionOptionsFromRecord,
  type SessionAgentOptions,
} from "../../runtime/engine/session-options.js";
import { TurnCompletionTracker } from "../../runtime/engine/turn-completion.js";
import {
  applyConfigOptionsToRecord,
  applyConfigOptionsToState,
} from "../../session/config-options.js";
import {
  cloneSessionAcpxState,
  cloneSessionConversation,
  recordClientOperation as recordConversationClientOperation,
  recordPromptSubmission,
  recordSessionUpdate as recordConversationSessionUpdate,
  trimConversationForRuntime,
} from "../../session/conversation-model.js";
import { SessionEventWriter } from "../../session/events.js";
import { LiveSessionCheckpoint } from "../../session/live-checkpoint.js";
import {
  clearDesiredConfigOption,
  getDesiredEffort,
  setDesiredEffort,
} from "../../session/mode-preference.js";
import {
  applyRequestedModelAndEffortIfAdvertised,
  applyRequestedModelPreferenceToRecord,
  clearDesiredEffortAfterUnrefreshedModelChange,
  currentModelIdFromSetModelResponse,
  reapplyDesiredEffortAfterModelChange,
} from "../../session/model-application.js";
import { advertisedModelState } from "../../session/model-state.js";
import type { PendingRequest } from "../../session/pending-requests.js";
import {
  absolutePath,
  isoNow,
  resolveSessionRecord,
  writeSessionRecord,
} from "../../session/persistence.js";
import type {
  AcpJsonRpcMessage,
  AcpMessageDirection,
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  OutputErrorAcpPayload,
  OutputErrorCode,
  OutputErrorEmissionPolicy,
  OutputErrorOrigin,
  OutputFormatter,
  PermissionEscalationEvent,
  PermissionPolicy,
  PermissionStats,
  RunPromptResult,
  SessionAcpxState,
  SessionRecord,
  SessionSendResult,
  TurnCompletionResult,
} from "../../types.js";
import { type QueueOwnerMessage, type QueueTask, waitMs } from "../queue/ipc.js";
import { type QueueOwnerActiveSessionController } from "../queue/owner-turn-controller.js";
import type { PendingRequestEvent } from "../queue/pending-request-manager.js";
import type { RunOnceOptions, SessionSendOptions } from "./contracts.js";

const INTERRUPT_CANCEL_WAIT_MS = 2_500;
const ONE_SHOT_REPLY_IDLE_MS = 100;

function oneShotInitialDrainIdleMs(
  options: Pick<RunOnceOptions, "agentCommand" | "agentArgv">,
): number | undefined {
  const parts = options.agentArgv
    ? { command: options.agentArgv[0] ?? "", args: options.agentArgv.slice(1) }
    : splitCommandLine(options.agentCommand);
  // Codex is the producer of the compaction/final-answer metadata this drain
  // protects, so it retains the complete late-marker horizon. Other agents do
  // not pay that one-second cost on every exec and compare row.
  return isCodexAcpCommand(parts.command, parts.args) ? undefined : ONE_SHOT_REPLY_IDLE_MS;
}

type RunSessionPromptOptions = Omit<
  SessionSendOptions,
  "maxQueueDepth" | "sessionId" | "ttlMs" | "waitForCompletion"
> & {
  sessionRecordId: string;
  requestedEffort?: string;
  handleProcessInterrupts?: boolean;
  /**
   * Hands back a sink that turns pending-request transitions into event-log
   * entries for THIS turn. Same shape as onClientAvailable: the turn owns the
   * log, so the producer has to be given a way in.
   */
  onPendingRequestSink?: (sink: (event: PendingRequestEvent) => void) => void;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
  onPromptActive?: () => Promise<void> | void;
};

type ActiveSessionController = QueueOwnerActiveSessionController;

type BufferedAcpOutputMessage = {
  direction: AcpMessageDirection;
  message: AcpJsonRpcMessage;
};

class QueueTaskOutputFormatter implements OutputFormatter {
  private readonly requestId: string;
  private readonly send: (message: QueueOwnerMessage) => void;

  constructor(task: QueueTask) {
    this.requestId = task.requestId;
    this.send = task.send;
  }

  setContext(_context: { sessionId: string }): void {}

  onAcpMessage(message: AcpJsonRpcMessage): void {
    this.send({
      type: "event",
      requestId: this.requestId,
      message,
    });
  }

  onError(params: {
    code: OutputErrorCode;
    detailCode?: string;
    origin?: OutputErrorOrigin;
    message: string;
    retryable?: boolean;
    acp?: OutputErrorAcpPayload;
    timestamp?: string;
  }): void {
    this.send({
      type: "error",
      requestId: this.requestId,
      code: params.code,
      detailCode: params.detailCode,
      origin: params.origin,
      message: params.message,
      retryable: params.retryable,
      acp: params.acp,
    });
  }

  onPermissionEscalation(event: PermissionEscalationEvent): void {
    this.send({
      type: "permission_escalation",
      requestId: this.requestId,
      event,
    });
  }

  flush(): void {}
}

const DISCARD_OUTPUT_FORMATTER: OutputFormatter = {
  setContext() {},
  onAcpMessage() {},
  onError() {},
  onPermissionEscalation() {},
  flush() {},
};

function markOutputAlreadyEmitted(error: unknown, outputAlreadyEmitted: boolean): void {
  if (!outputAlreadyEmitted || !error || typeof error !== "object") {
    return;
  }
  (error as { outputAlreadyEmitted?: boolean }).outputAlreadyEmitted = true;
}

async function runWithOptionalInterrupt<T>(options: {
  handleProcessInterrupts?: boolean;
  run: () => Promise<T>;
  handleInterrupt: () => Promise<void>;
}): Promise<T> {
  if (options.handleProcessInterrupts === false) {
    return await options.run();
  }
  return await withInterrupt(options.run, options.handleInterrupt);
}

function attachAcpErrorPayload(error: unknown, acp: OutputErrorAcpPayload | undefined): void {
  if (!acp || !error || typeof error !== "object") {
    return;
  }
  (error as { acp?: OutputErrorAcpPayload }).acp = acp;
}

function rendersAcpErrors(policy: OutputErrorEmissionPolicy | undefined): boolean {
  return policy?.queueErrorAlreadyEmitted ?? true;
}

function normalizedErrorText(value: string): string {
  return value.trim().toLowerCase();
}

function outboundAcpErrorMatches(error: unknown, acp: OutputErrorAcpPayload): boolean {
  const errorText = normalizedErrorText(formatErrorMessage(error));
  const details = (acp.data as { details?: unknown } | undefined)?.details;
  const candidate =
    typeof details === "string" && details.trim().length > 0 ? details : acp.message;
  const candidateText = normalizedErrorText(candidate);
  return errorText === candidateText || errorText.includes(candidateText);
}

class AcpErrorTracker {
  private latestInbound: OutputErrorAcpPayload | undefined;
  private readonly outbound: OutputErrorAcpPayload[] = [];

  reset(): void {
    this.latestInbound = undefined;
    this.outbound.length = 0;
  }

  observe(
    output: OutputFormatter,
    direction: AcpMessageDirection,
    message: AcpJsonRpcMessage,
  ): void {
    output.onAcpMessage(message);
    const acp = extractAcpError(message);
    if (!acp) {
      return;
    }
    if (direction === "inbound") {
      this.latestInbound = acp;
      return;
    }
    this.outbound.push(acp);
  }

  match(error: unknown): OutputErrorAcpPayload | undefined {
    return (
      this.latestInbound ?? this.outbound.findLast((acp) => outboundAcpErrorMatches(error, acp))
    );
  }
}

function toPromptResult(
  completion: TurnCompletionResult,
  sessionId: string,
  permissionStats: PermissionStats,
): RunPromptResult {
  const common = {
    sessionId,
    permissionStats,
  };
  if (completion.status === "incomplete") {
    return {
      status: completion.status,
      stopReason: completion.stopReason,
      reason: completion.reason,
      ...common,
    };
  }
  if (completion.status === "cancelled") {
    return {
      status: completion.status,
      stopReason: completion.stopReason,
      ...common,
    };
  }
  return {
    status: completion.status,
    stopReason: completion.stopReason,
    ...common,
  };
}

function applyConfigOptionResponseToState(
  state: SessionAcpxState | undefined,
  response:
    | Awaited<ReturnType<AcpClient["setSessionConfigOption"]>>
    | Awaited<ReturnType<AcpClient["setSessionModel"]>>,
): SessionAcpxState | undefined {
  if (!response?.configOptions) {
    return state;
  }
  return applyConfigOptionsToState(state, response.configOptions);
}

export function mergeConnectedModelState(
  state: SessionAcpxState | undefined,
  connectedState: SessionAcpxState | undefined,
): SessionAcpxState | undefined {
  if (!connectedState) {
    return state;
  }
  const nextState = cloneSessionAcpxState(state) ?? {};
  mergeConnectedAdvertisedModelState(nextState, connectedState);
  mergeConnectedModelPreferences(nextState, connectedState);
  return nextState;
}

function mergeConnectedAdvertisedModelState(
  nextState: SessionAcpxState,
  connectedState: SessionAcpxState,
): void {
  if (connectedState.config_options !== undefined) {
    nextState.config_options = structuredClone(connectedState.config_options);
  } else {
    delete nextState.config_options;
  }
  if (connectedState.current_model_id !== undefined) {
    nextState.current_model_id = connectedState.current_model_id;
  } else {
    delete nextState.current_model_id;
  }
  if (connectedState.available_models) {
    nextState.available_models = [...connectedState.available_models];
  } else {
    delete nextState.available_models;
  }
  if (connectedState.model_control) {
    nextState.model_control = connectedState.model_control;
  } else {
    delete nextState.model_control;
  }
}

function mergeConnectedModelPreferences(
  nextState: SessionAcpxState,
  connectedState: SessionAcpxState,
): void {
  if (connectedState.session_options) {
    nextState.session_options = cloneSessionAcpxState(connectedState)?.session_options;
  }
  if (connectedState.desired_mode_id !== undefined) {
    nextState.desired_mode_id = connectedState.desired_mode_id;
  }
  if (connectedState.desired_config_options) {
    nextState.desired_config_options = { ...connectedState.desired_config_options };
  }
}

async function applyPromptPreferences(params: {
  client: AcpClient;
  sessionId: string;
  requestedModel: string | undefined;
  requestedEffort: string | undefined;
  record: SessionRecord;
  timeoutMs?: number;
  suppressWarnings?: boolean;
}): Promise<void> {
  const models = advertisedModelState(params.record.acpx);
  const previousState = cloneSessionAcpxState(params.record.acpx);
  const previousEffortConfigId = effortStateFromConfigOptions(
    params.record.acpx?.config_options,
  )?.configId;
  const replacesEffort = Boolean(params.requestedEffort?.trim());
  const application = await applyRequestedModelAndEffortIfAdvertised({
    client: params.client,
    sessionId: params.sessionId,
    requestedModel: params.requestedModel,
    requestedEffort: params.requestedEffort,
    models,
    configOptions: params.record.acpx?.config_options,
    agentCommand: params.record.agentCommand,
    timeoutMs: params.timeoutMs,
    onWarning: (warning) => emitModelSupportWarning(warning, params.suppressWarnings),
    onModelApplied: (modelApplication) => {
      applyRequestedModelPreferenceToRecord({
        record: params.record,
        application: modelApplication,
        requestedModel: params.requestedModel,
        initialModels: models,
        previousEffortConfigId,
        replacesEffort,
      });
    },
  });
  applyConfigOptionsToRecord(params.record, application.effort.response);

  if (application.effort.applied) {
    setDesiredEffort(params.record, params.requestedEffort, application.effort.configId);
  }
  // A legacy session/set_model success has no config response, so it cannot
  // prove that the old model's effort remains valid for the new model. The
  // model preference update intentionally clears that unverified selection;
  // replay only after a config response refreshes model-aware capabilities.
  if (application.model.response) {
    await reapplySavedPromptEffort({
      client: params.client,
      sessionId: params.sessionId,
      record: params.record,
      previousState,
      replacesEffort,
      timeoutMs: params.timeoutMs,
    });
  }
}

async function reapplySavedPromptEffort(params: {
  client: AcpClient;
  sessionId: string;
  record: SessionRecord;
  previousState: SessionAcpxState | undefined;
  replacesEffort: boolean;
  timeoutMs?: number;
}): Promise<void> {
  if (
    params.replacesEffort ||
    params.record.acpx?.config_options === undefined ||
    !getDesiredEffort(params.previousState)
  ) {
    return;
  }
  const effort = await reapplyDesiredEffortAfterModelChange({
    client: params.client,
    sessionId: params.sessionId,
    previousState: params.previousState,
    nextState: params.record.acpx,
    timeoutMs: params.timeoutMs,
    onReconciledState: (state) => {
      params.record.acpx = state;
    },
  });
  params.record.acpx = effort.state;
}

function emitModelSupportWarning(warning: string | undefined, suppressWarnings?: boolean): void {
  if (warning && !suppressWarnings) {
    process.stderr.write(`[acpx] warning: ${warning}\n`);
  }
}

function storeActiveEffortPreference(params: {
  state: SessionAcpxState;
  effortConfigId: string;
  effort: string;
  previousEffortConfigId: string | undefined;
}): void {
  if (params.previousEffortConfigId !== params.effortConfigId) {
    clearDesiredConfigOption(params.state, params.previousEffortConfigId);
  }
  params.state.session_options = { ...params.state.session_options, effort: params.effort };
  params.state.desired_config_options = {
    ...params.state.desired_config_options,
    [params.effortConfigId]: params.effort,
  };
}

function clearActiveEffortPreference(
  state: SessionAcpxState,
  previousEffortConfigId: string | undefined,
): void {
  clearDesiredConfigOption(state, previousEffortConfigId);
  clearDesiredConfigOption(state, effortStateFromConfigOptions(state.config_options)?.configId);
  const sessionOptions = { ...state.session_options };
  delete sessionOptions.effort;
  if (Object.keys(sessionOptions).length > 0) {
    state.session_options = sessionOptions;
  } else {
    delete state.session_options;
  }
}

function applyActiveModelPreferenceState(params: {
  state: SessionAcpxState | undefined;
  application: Awaited<ReturnType<typeof applyRequestedModelAndEffortIfAdvertised>>["model"];
  modelId: string | undefined;
  initialModelId: string | undefined;
  modelConfigId: string | undefined;
  previousEffortConfigId: string | undefined;
  replacesEffort: boolean;
}): SessionAcpxState {
  const state = applyConfigOptionResponseToState(params.state, params.application.response);
  const nextState = cloneSessionAcpxState(state) ?? {};
  if (!params.application.applied) {
    return nextState;
  }
  nextState.session_options = { ...nextState.session_options, model: params.modelId };
  nextState.current_model_id = currentModelIdFromSetModelResponse(
    params.application.response,
    params.modelId,
  );
  clearDesiredConfigOption(nextState, params.modelConfigId);
  if (params.replacesEffort && params.initialModelId !== params.modelId) {
    clearActiveEffortPreference(nextState, params.previousEffortConfigId);
  }
  return nextState;
}

function applyActivePreferenceState(params: {
  state: SessionAcpxState | undefined;
  application: Awaited<ReturnType<typeof applyRequestedModelAndEffortIfAdvertised>>;
  modelId: string | undefined;
  initialModelId: string | undefined;
  effort: string;
  modelConfigId: string | undefined;
  previousEffortConfigId: string | undefined;
}): { state: SessionAcpxState; effortConfigId: string } {
  let state = applyActiveModelPreferenceState({
    state: params.state,
    application: params.application.model,
    modelId: params.modelId,
    initialModelId: params.initialModelId,
    modelConfigId: params.modelConfigId,
    previousEffortConfigId: params.previousEffortConfigId,
    replacesEffort: true,
  });
  state = applyConfigOptionResponseToState(state, params.application.effort.response) ?? state;
  const nextState = cloneSessionAcpxState(state) ?? {};
  const effortConfigId = params.application.effort.configId;
  if (!effortConfigId) {
    throw new Error("Applied effort did not resolve to an ACP session config option");
  }
  storeActiveEffortPreference({
    state: nextState,
    effortConfigId,
    effort: params.effort,
    previousEffortConfigId: params.previousEffortConfigId,
  });
  return { state: nextState, effortConfigId };
}

function notifyActiveModelState(
  callback: ((state: SessionAcpxState) => void | Promise<void>) | undefined,
  state: SessionAcpxState,
): void | Promise<void> {
  return callback?.(state);
}

function activePreferenceResponse(
  application: Awaited<ReturnType<typeof applyRequestedModelAndEffortIfAdvertised>>,
  state: SessionAcpxState,
): Awaited<ReturnType<AcpClient["setSessionConfigOption"]>> {
  return (
    application.effort.response ??
    application.model.response ?? {
      configOptions: structuredClone(state.config_options ?? []),
    }
  );
}

function currentModelIdFromActiveState(state: SessionAcpxState, fallbackModelId: string): string {
  return modelStateFromConfigOptions(state.config_options)?.currentModelId ?? fallbackModelId;
}

async function applyActiveSessionPreferences(params: {
  client: AcpClient;
  sessionId: string;
  record: SessionRecord;
  state: SessionAcpxState | undefined;
  modelId: string | undefined;
  effort: string;
  onModelApplied?: (state: SessionAcpxState) => void | Promise<void>;
}): Promise<{
  state: SessionAcpxState;
  effortConfigId: string;
  response: Awaited<ReturnType<AcpClient["setSessionConfigOption"]>>;
}> {
  const models = advertisedModelState(params.state);
  const previousEffortConfigId = effortStateFromConfigOptions(
    params.state?.config_options,
  )?.configId;
  let state = params.state;
  const application = await applyRequestedModelAndEffortIfAdvertised({
    client: params.client,
    sessionId: params.sessionId,
    requestedModel: params.modelId,
    requestedEffort: params.effort,
    models,
    configOptions: params.state?.config_options,
    agentCommand: params.record.agentCommand,
    onModelApplied: async (modelApplication) => {
      state = applyActiveModelPreferenceState({
        state,
        application: modelApplication,
        modelId: params.modelId,
        initialModelId: models?.currentModelId,
        modelConfigId: models?.configId,
        previousEffortConfigId,
        replacesEffort: true,
      });
      await notifyActiveModelState(params.onModelApplied, state);
    },
  });
  const applied = applyActivePreferenceState({
    state,
    application,
    modelId: params.modelId,
    initialModelId: models?.currentModelId,
    effort: params.effort,
    modelConfigId: models?.configId,
    previousEffortConfigId,
  });
  return {
    ...applied,
    response: activePreferenceResponse(application, applied.state),
  };
}

function storeActiveConfigSelection(params: {
  state: SessionAcpxState | undefined;
  previousModelConfigId: string | undefined;
  configId: string;
  value: string;
}): { state: SessionAcpxState; changedModel: boolean } {
  const state = cloneSessionAcpxState(params.state) ?? {};
  const modelConfigId = modelStateFromConfigOptions(state.config_options)?.configId;
  const effortConfigId = effortStateFromConfigOptions(state.config_options)?.configId;
  const changedModel =
    params.configId === params.previousModelConfigId || params.configId === modelConfigId;
  if (changedModel) {
    state.session_options = { ...state.session_options, model: params.value };
    state.current_model_id = currentModelIdFromActiveState(state, params.value);
    clearDesiredConfigOption(state, params.configId);
  } else if (params.configId === "mode") {
    state.desired_mode_id = params.value;
  } else if (params.configId === effortConfigId) {
    storeActiveEffortPreference({
      state,
      effortConfigId: params.configId,
      effort: params.value,
      previousEffortConfigId: effortConfigId,
    });
  } else {
    state.desired_config_options = {
      ...state.desired_config_options,
      [params.configId]: params.value,
    };
  }
  return { state, changedModel };
}

async function setActiveSessionConfigOption(params: {
  client: AcpClient;
  sessionId: string;
  state: SessionAcpxState | undefined;
  configId: string;
  value: string;
  onReconciledState?: (state: SessionAcpxState) => void;
}): Promise<{
  state: SessionAcpxState;
  response: Awaited<ReturnType<AcpClient["setSessionConfigOption"]>>;
}> {
  const previousState = cloneSessionAcpxState(params.state);
  const previousModelConfigId = modelStateFromConfigOptions(
    previousState?.config_options,
  )?.configId;
  const response = await params.client.setSessionConfigOption(
    params.sessionId,
    params.configId,
    params.value,
  );
  const responseState = applyConfigOptionResponseToState(params.state, response);
  const stored = storeActiveConfigSelection({
    state: responseState,
    previousModelConfigId,
    configId: params.configId,
    value: params.value,
  });
  if (!stored.changedModel) {
    return { state: stored.state, response };
  }
  const effort = await reapplyDesiredEffortAfterModelChange({
    client: params.client,
    sessionId: params.sessionId,
    previousState,
    nextState: stored.state,
    onReconciledState: params.onReconciledState,
  });
  return { state: effort.state, response: effort.response ?? response };
}

function jsonRpcIdKey(value: unknown): string | undefined {
  if (typeof value === "string") {
    return `s:${value}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `n:${value}`;
  }
  return undefined;
}

function extractJsonRpcRequestInfo(
  message: AcpJsonRpcMessage,
): { idKey: string; method: string } | undefined {
  const candidate = message as { method?: unknown; id?: unknown };
  if (typeof candidate.method !== "string") {
    return undefined;
  }
  const idKey = jsonRpcIdKey(candidate.id);
  if (!idKey) {
    return undefined;
  }
  return {
    idKey,
    method: candidate.method,
  };
}

function extractJsonRpcResponseInfo(
  message: AcpJsonRpcMessage,
): { idKey: string; hasError: boolean } | undefined {
  const candidate = message as { id?: unknown; error?: unknown; result?: unknown };
  const idKey = jsonRpcIdKey(candidate.id);
  if (!idKey) {
    return undefined;
  }
  const hasError = Object.hasOwn(candidate, "error");
  const hasResult = Object.hasOwn(candidate, "result");
  if (!hasError && !hasResult) {
    return undefined;
  }
  return {
    idKey,
    hasError,
  };
}

const SESSION_RECONNECT_METHODS = new Set(["session/load", "session/resume"]);

function filterRecoverableLoadFallbackOutput(messages: AcpJsonRpcMessage[]): AcpJsonRpcMessage[] {
  const requestMethodById = new Map<string, string>();
  const failedLoadRequestIds = new Set<string>();

  for (const message of messages) {
    const request = extractJsonRpcRequestInfo(message);
    if (request) {
      requestMethodById.set(request.idKey, request.method);
      continue;
    }

    const response = extractJsonRpcResponseInfo(message);
    if (!response || !response.hasError) {
      continue;
    }

    const requestMethod = requestMethodById.get(response.idKey);
    if (requestMethod && SESSION_RECONNECT_METHODS.has(requestMethod)) {
      failedLoadRequestIds.add(response.idKey);
    }
  }

  if (failedLoadRequestIds.size === 0) {
    return messages;
  }

  return messages.filter((message) => {
    const request = extractJsonRpcRequestInfo(message);
    if (
      request &&
      SESSION_RECONNECT_METHODS.has(request.method) &&
      failedLoadRequestIds.has(request.idKey)
    ) {
      return false;
    }

    const response = extractJsonRpcResponseInfo(message);
    if (response && failedLoadRequestIds.has(response.idKey)) {
      return false;
    }

    return true;
  });
}

function filterBufferedConnectOutput(
  messages: BufferedAcpOutputMessage[],
  loadError: string | undefined,
): BufferedAcpOutputMessage[] {
  if (loadError == null) {
    return messages;
  }
  const filteredMessages = new Set(
    filterRecoverableLoadFallbackOutput(messages.map(({ message }) => message)),
  );
  return messages.filter(({ message }) => filteredMessages.has(message));
}

function emitPromptRetryNotice(params: {
  error: unknown;
  delayMs: number;
  attempt: number;
  maxRetries: number;
  suppressSdkConsoleErrors?: boolean;
}): void {
  if (params.suppressSdkConsoleErrors) {
    return;
  }

  process.stderr.write(
    `[acpx] prompt failed (${formatErrorMessage(params.error)}), retrying in ${params.delayMs}ms ` +
      `(attempt ${params.attempt}/${params.maxRetries})\n`,
  );
}

function emitConnectPerfMetric(startedAt: number, verbose?: boolean): void {
  if (!verbose) {
    return;
  }
  process.stderr.write(
    `[acpx] ${formatPerfMetric("prompt.connect_and_load", Date.now() - startedAt)}\n`,
  );
}

function emitPromptPerfMetric(startedAt: number, verbose?: boolean): void {
  if (!verbose) {
    return;
  }
  process.stderr.write(`[acpx] ${formatPerfMetric("prompt.agent_turn", Date.now() - startedAt)}\n`);
}

function emitPromptHookError(error: unknown, verbose?: boolean): void {
  if (!verbose) {
    return;
  }
  process.stderr.write("[acpx] onPromptActive hook failed: " + formatErrorMessage(error) + "\n");
}

function emitPromptDisconnectNotice(
  snapshot: ReturnType<AcpClient["getAgentLifecycleSnapshot"]>,
  verbose?: boolean,
): void {
  const lastExit = snapshot.lastExit;
  if (!lastExit?.unexpectedDuringPrompt || !verbose) {
    return;
  }
  process.stderr.write(
    "[acpx] agent disconnected during prompt (" +
      lastExit.reason +
      ", exit=" +
      lastExit.exitCode +
      ", signal=" +
      (lastExit.signal ?? "none") +
      ")\n",
  );
}

function shouldRetryRuntimePrompt(
  error: unknown,
  attempt: number,
  maxRetries: number,
  snapshot: ReturnType<AcpClient["getAgentLifecycleSnapshot"]>,
  hasSideEffects: () => boolean,
): boolean {
  if (!shouldRetryPromptAttempt(error, attempt, maxRetries, hasSideEffects)) {
    return false;
  }
  return snapshot.lastExit?.unexpectedDuringPrompt !== true;
}

function shouldRetryPromptAttempt(
  error: unknown,
  attempt: number,
  maxRetries: number,
  hasSideEffects: () => boolean,
): boolean {
  return attempt < maxRetries && !hasSideEffects() && isRetryablePromptError(error);
}

async function waitBeforePromptRetry(
  error: unknown,
  attempt: number,
  maxRetries: number,
  suppressSdkConsoleErrors?: boolean,
): Promise<void> {
  const delayMs = Math.min(1_000 * 2 ** attempt, 10_000);
  emitPromptRetryNotice({
    error,
    delayMs,
    attempt: attempt + 1,
    maxRetries,
    suppressSdkConsoleErrors,
  });
  await waitMs(delayMs);
}

type QueuedTaskRuntimeOptions = Parameters<typeof runQueuedTask>[2];

/**
 * Synthetic JSON-RPC notification for an acpx-originated event. Underscore
 * prefix marks it as a client extension so an ACP reader can skip it; the event
 * log accepts any well-formed notification.
 */
function acpxExtensionNotification(method: string, params: unknown): AcpJsonRpcMessage {
  return { jsonrpc: "2.0", method, params };
}

function emitIncompleteTurn(
  completion: TurnCompletionResult,
  output: OutputFormatter,
  permissionStats: RunPromptResult["permissionStats"],
  pendingMessages?: AcpJsonRpcMessage[],
): void {
  if (completion.status !== "incomplete") {
    return;
  }
  const notification = acpxExtensionNotification("_acpx/turn_incomplete", {
    reason: completion.reason,
    stopReason: completion.stopReason,
  });
  pendingMessages?.push(notification);
  if (!permissionDenialTakesPrecedence(permissionStats)) {
    output.onAcpMessage(notification);
  }
}

/**
 * The request as the event log carries it.
 *
 * The agent-authored bulk — a permission request's raw tool input, an
 * elicitation's requested schema — is dropped: both can be large and are
 * repeated on every transition, and the durable store already holds them
 * verbatim, so the log carries identity and the entry is where the detail
 * lives.
 */
function pendingRequestForEventLog(request: PendingRequest): Record<string, unknown> {
  if (request.kind === "elicitation") {
    const { requestedSchema: _requestedSchema, ...elicitation } = request.elicitation;
    return { ...request, elicitation };
  }
  const { rawInput: _rawInput, ...toolCall } = request.toolCall;
  return { ...request, toolCall };
}

/**
 * Report a parked request's transitions, and mark the turn as having done
 * something.
 *
 * Parking writes a durable record an operator can list and answer, so a turn
 * that parked is a turn that touched the outside world. Retrying it would ask a
 * second time while the first request is still sitting there waiting — which is
 * exactly what the side-effect guard on prompt retries exists to prevent.
 */
function registerPendingRequestSink(
  options: RunSessionPromptOptions,
  output: OutputFormatter,
  pendingMessages: AcpJsonRpcMessage[],
  markSideEffect: () => void,
): void {
  options.onPendingRequestSink?.(
    createPendingRequestSink({ output, pendingMessages, markSideEffect }),
  );
}

function createPendingRequestSink(params: {
  output: OutputFormatter;
  pendingMessages: AcpJsonRpcMessage[];
  markSideEffect: () => void;
}): (event: PendingRequestEvent) => void {
  return (event) => {
    params.markSideEffect();
    const notification = acpxExtensionNotification("_acpx/pending_request", {
      ...event,
      request: pendingRequestForEventLog(event.request),
    });
    params.pendingMessages.push(notification);
    // Attached --format json clients see park/answer transitions live.
    params.output.onAcpMessage(notification);
  };
}

function buildQueuedTaskRunOptions(
  sessionRecordId: string,
  task: QueueTask,
  options: QueuedTaskRuntimeOptions,
  outputFormatter: OutputFormatter,
): RunSessionPromptOptions {
  const preferences = mergeQueuedTaskSessionPreferences(
    task.sessionOptions,
    options.sessionOptions,
  );
  return {
    sessionRecordId,
    mcpServers: options.mcpServers,
    prompt: task.prompt ?? textPrompt(task.message),
    permissionMode: task.permissionMode,
    resumePolicy: task.resumePolicy,
    nonInteractivePermissions: task.nonInteractivePermissions ?? options.nonInteractivePermissions,
    permissionPolicy: task.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    outputFormatter,
    errorEmissionPolicy: { queueErrorAlreadyEmitted: true },
    timeoutMs: task.timeoutMs,
    suppressSdkConsoleErrors: task.suppressSdkConsoleErrors ?? options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    promptRetries: task.promptRetries ?? options.promptRetries ?? 0,
    ...preferences,
    onClientAvailable: options.onClientAvailable,
    onClientClosed: options.onClientClosed,
    onPromptActive: options.onPromptActive,
    onPendingRequestSink: options.onPendingRequestSink,
    handleProcessInterrupts: options.handleProcessInterrupts,
    client: options.sharedClient,
  };
}

function mergeQueuedTaskSessionPreferences(
  taskOptions: SessionAgentOptions | undefined,
  ownerOptions: SessionAgentOptions | undefined,
): Pick<RunSessionPromptOptions, "sessionOptions" | "requestedEffort"> {
  const sessionOptions = mergeSessionOptions(taskOptions, ownerOptions);
  return {
    sessionOptions,
    requestedEffort: sessionOptions?.effort,
  };
}

function sendQueuedTaskResult(task: QueueTask, result: SessionSendResult): void {
  if (!task.waitForCompletion) {
    return;
  }
  task.send({
    type: "result",
    requestId: task.requestId,
    result,
  });
}

function sendQueuedTaskError(task: QueueTask, error: unknown): void {
  if (!task.waitForCompletion) {
    return;
  }
  const normalizedError = normalizeOutputError(error, {
    origin: "runtime",
    detailCode: "QUEUE_RUNTIME_PROMPT_FAILED",
  });
  const alreadyEmitted =
    (error as { outputAlreadyEmitted?: unknown }).outputAlreadyEmitted === true;
  task.send({
    type: "error",
    requestId: task.requestId,
    code: normalizedError.code,
    detailCode: normalizedError.detailCode,
    origin: normalizedError.origin,
    message: normalizedError.message,
    retryable: normalizedError.retryable,
    acp: normalizedError.acp,
    outputAlreadyEmitted: alreadyEmitted,
  });
}

export async function runQueuedTask(
  sessionRecordId: string,
  task: QueueTask,
  options: {
    sharedClient?: AcpClient;
    verbose?: boolean;
    mcpServers?: McpServer[];
    nonInteractivePermissions?: NonInteractivePermissionPolicy;
    permissionPolicy?: PermissionPolicy;
    authCredentials?: Record<string, string>;
    authPolicy?: AuthPolicy;
    suppressSdkConsoleErrors?: boolean;
    promptRetries?: number;
    sessionOptions?: SessionAgentOptions;
    onClientAvailable?: (controller: ActiveSessionController) => void;
    onClientClosed?: () => void;
    onPromptActive?: () => Promise<void> | void;
    onPendingRequestSink?: (sink: (event: PendingRequestEvent) => void) => void;
    handleProcessInterrupts?: boolean;
  },
): Promise<void> {
  const outputFormatter = task.waitForCompletion
    ? new QueueTaskOutputFormatter(task)
    : DISCARD_OUTPUT_FORMATTER;

  try {
    const result = await runSessionPrompt(
      buildQueuedTaskRunOptions(sessionRecordId, task, options, outputFormatter),
    );
    sendQueuedTaskResult(task, result);
  } catch (error) {
    sendQueuedTaskError(task, error);
    if (error instanceof InterruptedError) {
      throw error;
    }
  } finally {
    task.close();
  }
}

async function runSessionPrompt(options: RunSessionPromptOptions): Promise<SessionSendResult> {
  const stopTotalTimer = startPerfTimer("runtime.prompt.total");
  const output = options.outputFormatter;
  const shouldMarkAcpErrorsEmitted = rendersAcpErrors(options.errorEmissionPolicy);
  const record = await measurePerf("session.resolve_prompt_record", async () => {
    return await resolveSessionRecord(options.sessionRecordId);
  });
  const allowFreshSessionForFirstPrompt = canCreateFirstPromptProviderSession(record);
  const conversation = cloneSessionConversation(record);
  let acpxState = cloneSessionAcpxState(record.acpx);
  const promptStartedAt = isoNow();
  const promptMessageId = recordPromptSubmission(conversation, options.prompt, promptStartedAt);
  record.lastPromptAt = promptStartedAt;
  record.lastUsedAt = promptStartedAt;
  applyConversation(record, conversation);
  record.acpx = acpxState;
  await writeSessionRecord(record);

  output.setContext({
    sessionId: record.acpxRecordId,
  });

  const eventWriter = await measurePerf("session.events.open", async () => {
    return await SessionEventWriter.open(record);
  });
  const pendingMessages: AcpJsonRpcMessage[] = [];
  const pendingConnectOutputMessages: BufferedAcpOutputMessage[] = [];
  const sessionOptions = mergeSessionOptions(
    options.sessionOptions,
    sessionOptionsFromRecord(record),
  );
  let bufferingConnectOutput = true;
  let promptTurnActive = false;
  let promptTurnHadSideEffects = false;
  const completionTracker = new TurnCompletionTracker();
  const acpErrors = new AcpErrorTracker();
  let eventWriterClosed = false;

  const closeEventWriter = async (checkpoint: boolean): Promise<void> => {
    if (eventWriterClosed) {
      return;
    }
    eventWriterClosed = true;
    await eventWriter.close({ checkpoint });
  };

  const flushPendingMessages = async (checkpoint = false): Promise<void> => {
    if (pendingMessages.length === 0) {
      return;
    }

    const batch = pendingMessages.splice(0);
    await measurePerf("session.events.flush_pending", async () => {
      await eventWriter.appendMessages(batch, { checkpoint });
    });
  };
  const preserveClosedState = async (): Promise<void> => {
    const latest = await resolveSessionRecord(record.acpxRecordId).catch(() => undefined);
    if (!latest?.closed) {
      return;
    }

    record.closed = true;
    record.closedAt = latest.closedAt ?? record.closedAt ?? isoNow();
    record.pid = latest.pid;
    if (latest.acpx) {
      record.acpx = {
        ...record.acpx,
        ...latest.acpx,
      };
    }
  };
  const liveCheckpoint = new LiveSessionCheckpoint({
    save: async () => {
      await flushPendingMessages(false);
      record.lastUsedAt = isoNow();
      applyConversation(record, conversation);
      record.acpx = acpxState;
      await preserveClosedState();
      await eventWriter.checkpoint();
    },
    onError: (error) => {
      if (options.verbose) {
        process.stderr.write(
          "[acpx] live session checkpoint failed: " + formatErrorMessage(error) + "\n",
        );
      }
    },
  });

  const ownClient = options.client == null;
  const client =
    options.client ??
    new AcpClient({
      agentCommand: record.agentCommand,
      agentArgv: record.agentArgv,
      cwd: absolutePath(record.cwd),
      mcpServers: options.mcpServers,
      permissionMode: options.permissionMode,
      nonInteractivePermissions: options.nonInteractivePermissions,
      permissionPolicy: options.permissionPolicy,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      fs: options.fs,
      terminal: options.terminal,
      suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
      verbose: options.verbose,
      sessionOptions,
    });
  client.updateRuntimeOptions({
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    fs: options.fs,
    terminal: options.terminal,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
  });
  client.setEventHandlers({
    onAcpMessage: (direction, message) => {
      pendingMessages.push(message);
      options.onAcpMessage?.(direction, message);
    },
    onAcpOutputMessage: (direction, message) => {
      if (bufferingConnectOutput) {
        pendingConnectOutputMessages.push({ direction, message });
        return;
      }
      acpErrors.observe(output, direction, message);
    },
    onSessionUpdate: (notification) => {
      completionTracker.observe(notification);
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      acpxState = recordConversationSessionUpdate(conversation, acpxState, notification);
      trimConversationForRuntime(conversation);
      liveCheckpoint.request();
      options.onSessionUpdate?.(notification);
    },
    onClientOperation: (operation) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      acpxState = recordConversationClientOperation(conversation, acpxState, operation);
      trimConversationForRuntime(conversation);
      liveCheckpoint.request();
      options.onClientOperation?.(operation);
    },
    onPermissionEscalation: (event) => {
      // Also land it in the durable event log. The formatter is discarded for
      // --no-wait turns, so without this an escalation leaves no trace at all.
      pendingMessages.push(acpxExtensionNotification("_acpx/permission_escalation", event));
      output.onPermissionEscalation(event);
      options.onPermissionEscalation?.(event);
    },
  });
  registerPendingRequestSink(options, output, pendingMessages, () => {
    promptTurnHadSideEffects = true;
  });
  let activeSessionIdForControl = record.acpSessionId;
  let notifiedClientAvailable = false;
  const activeController: ActiveSessionController = {
    hasActivePrompt: () => client.hasActivePrompt(),
    requestCancelActivePrompt: async () => await client.requestCancelActivePrompt(),
    setSessionMode: async (modeId: string) => {
      await client.setSessionMode(activeSessionIdForControl, modeId);
    },
    setSessionModel: async (modelId: string) => {
      const previousState = cloneSessionAcpxState(acpxState);
      const models = advertisedModelState(acpxState);
      const response = await client.setSessionModel(activeSessionIdForControl, modelId, models);
      acpxState = applyConfigOptionResponseToState(acpxState, response);
      const nextState = cloneSessionAcpxState(acpxState) ?? {};
      nextState.session_options = { ...nextState.session_options, model: modelId };
      nextState.current_model_id = currentModelIdFromSetModelResponse(response, modelId);
      clearDesiredConfigOption(nextState, models?.configId);
      acpxState = nextState;
      if (!response) {
        acpxState = clearDesiredEffortAfterUnrefreshedModelChange({
          state: acpxState,
          modelResponse: response,
          previousModelId: models?.currentModelId,
          requestedModelId: modelId,
          previousEffortConfigId: effortStateFromConfigOptions(previousState?.config_options)
            ?.configId,
        });
        return response;
      }
      const effort = await reapplyDesiredEffortAfterModelChange({
        client,
        sessionId: activeSessionIdForControl,
        previousState,
        nextState: acpxState,
        onReconciledState: async (state) => {
          acpxState = state;
          await liveCheckpoint.checkpoint();
        },
      });
      acpxState = effort.state;
      return effort.response ?? response;
    },
    setSessionConfigOption: async (configId: string, value: string) => {
      const result = await setActiveSessionConfigOption({
        client,
        sessionId: activeSessionIdForControl,
        state: acpxState,
        configId,
        value,
        onReconciledState: async (state) => {
          acpxState = state;
          await liveCheckpoint.checkpoint();
        },
      });
      acpxState = result.state;
      return result.response;
    },
    applySessionPreferences: async (modelId: string | undefined, effort: string) => {
      const result = await applyActiveSessionPreferences({
        client,
        sessionId: activeSessionIdForControl,
        record,
        state: acpxState,
        modelId,
        effort,
        onModelApplied: async (state) => {
          acpxState = state;
          await liveCheckpoint.checkpoint();
        },
      });
      acpxState = result.state;
      return {
        effortConfigId: result.effortConfigId,
        response: result.response,
      };
    },
  };

  const flushConnectOutput = (loadError?: string): void => {
    bufferingConnectOutput = false;
    const outputMessages = filterBufferedConnectOutput(pendingConnectOutputMessages, loadError);
    for (const { direction, message } of outputMessages) {
      acpErrors.observe(output, direction, message);
    }
    pendingConnectOutputMessages.length = 0;
  };

  const connectForPrompt = async () => {
    const connectStartedAt = Date.now();
    try {
      const connected = await measurePerf("runtime.connect_and_load", async () => {
        return await connectAndLoadSession({
          client,
          record,
          resumePolicy: options.resumePolicy ?? "same-session-only",
          allowFreshSessionForFirstPrompt,
          timeoutMs: options.timeoutMs,
          verbose: options.verbose,
          suppressWarnings: options.suppressSdkConsoleErrors,
          activeController,
          onConnectedRecord: (connectedRecord) => {
            connectedRecord.lastPromptAt = isoNow();
          },
          onSessionIdResolved: (sessionId) => {
            activeSessionIdForControl = sessionId;
          },
          onWarning: (warning) => {
            // The turn still runs, so the only way an operator learns the mode
            // is not in force is the durable log plus the live JSON stream.
            const notification = acpxExtensionNotification("_acpx/warning", warning);
            pendingMessages.push(notification);
            output.onAcpMessage(notification);
          },
        });
      });
      acpxState = mergeConnectedModelState(acpxState, record.acpx);
      flushConnectOutput(connected.loadError);
      emitConnectPerfMetric(connectStartedAt, options.verbose);
      return connected;
    } catch (error) {
      flushConnectOutput();
      throw error;
    }
  };

  const buildPromptStartedHook = (attempt: number) => {
    if (attempt !== 0 || !options.onPromptActive) {
      return undefined;
    }
    return async () => {
      try {
        await options.onPromptActive?.();
      } catch (error) {
        emitPromptHookError(error, options.verbose);
      }
    };
  };

  const runPromptAttempt = async (sessionId: string, attempt: number) => {
    acpErrors.reset();
    const promptStartedAt = Date.now();
    const response = await measurePerf("runtime.prompt.agent_turn", async () => {
      return await runPromptTurn({
        client,
        sessionId,
        prompt: options.prompt,
        timeoutMs: options.timeoutMs,
        conversation,
        promptMessageId,
        onPromptStarted: buildPromptStartedHook(attempt),
        completionTracker,
      });
    });
    emitPromptPerfMetric(promptStartedAt, options.verbose);
    return response;
  };

  const handlePromptFailure = async (error: unknown, attempt: number): Promise<"retry"> => {
    const snapshot = client.getAgentLifecycleSnapshot();
    if (
      shouldRetryRuntimePrompt(
        error,
        attempt,
        options.promptRetries ?? 0,
        snapshot,
        () => promptTurnHadSideEffects,
      )
    ) {
      await waitBeforePromptRetry(
        error,
        attempt,
        options.promptRetries ?? 0,
        options.suppressSdkConsoleErrors,
      );
      return promptTurnHadSideEffects ? await failRuntimePrompt(error, snapshot) : "retry";
    }
    return await failRuntimePrompt(error, snapshot);
  };

  const failRuntimePrompt = async (
    error: unknown,
    snapshot: ReturnType<AcpClient["getAgentLifecycleSnapshot"]>,
  ): Promise<never> => {
    promptTurnActive = false;
    applyLifecycleSnapshotToRecord(record, snapshot);
    emitPromptDisconnectNotice(snapshot, options.verbose);
    const matchedAcpError = acpErrors.match(error);
    const normalizedError = normalizeOutputError(error, {
      origin: "runtime",
      acp: matchedAcpError,
    });
    await flushPendingMessages(false).catch(() => {
      // best effort while bubbling prompt failure
    });
    output.flush();
    record.lastUsedAt = isoNow();
    applyConversation(record, conversation);
    record.acpx = acpxState;
    const propagated = error instanceof Error ? error : new Error(formatErrorMessage(error));
    attachAcpErrorPayload(propagated, normalizedError.acp);
    (propagated as { outputAlreadyEmitted?: boolean }).outputAlreadyEmitted =
      matchedAcpError !== undefined && shouldMarkAcpErrorsEmitted;
    (propagated as { normalizedOutputError?: unknown }).normalizedOutputError = normalizedError;
    throw propagated;
  };

  const runPromptWithRetries = async (sessionId: string) => {
    promptTurnActive = true;
    for (let attempt = 0; ; attempt++) {
      try {
        return await runPromptAttempt(sessionId, attempt);
      } catch (error) {
        if ((await handlePromptFailure(error, attempt)) === "retry") {
          continue;
        }
      }
    }
  };

  const savePromptSuccess = async (
    response: Awaited<ReturnType<typeof runPromptTurn>>,
    permissionStats: PermissionStats,
  ) => {
    emitIncompleteTurn(response, output, permissionStats, pendingMessages);
    await flushPendingMessages(false);
    output.flush();
    const now = isoNow();
    record.lastUsedAt = now;
    record.closed = false;
    record.closedAt = undefined;
    record.protocolVersion = client.initializeResult?.protocolVersion;
    record.agentCapabilities = client.initializeResult?.agentCapabilities;
    applyConversation(record, conversation);
    record.acpx = acpxState;
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    stopTotalTimer();
    return response;
  };

  const runPrompt = async (): Promise<SessionSendResult> => {
    const { sessionId: activeSessionId, resumed, loadError } = await connectForPrompt();

    await applyPromptPreferences({
      client,
      sessionId: activeSessionId,
      requestedModel: sessionOptions?.model,
      requestedEffort: options.requestedEffort,
      record,
      timeoutMs: options.timeoutMs,
      suppressWarnings: options.suppressSdkConsoleErrors,
    }).finally(() => {
      acpxState = cloneSessionAcpxState(record.acpx);
    });
    options.onClientAvailable?.(activeController);
    notifiedClientAvailable = true;

    output.setContext({
      sessionId: record.acpxRecordId,
    });
    await liveCheckpoint.checkpoint();

    const permissionStatsBeforePrompt = client.getPermissionStats();
    const response = await runPromptWithRetries(activeSessionId);
    const permissionStats = permissionStatsDelta(
      client.getPermissionStats(),
      permissionStatsBeforePrompt,
    );
    await savePromptSuccess(response, permissionStats);
    promptTurnActive = false;

    return {
      ...toPromptResult(response, record.acpxRecordId, permissionStats),
      record,
      resumed,
      loadError,
    };
  };

  const handleInterrupt = async (): Promise<void> => {
    await client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS).catch(() => {
      // Cancellation is best effort; persistence, buffered output, and client
      // cleanup still have to finish before the interrupt is reported.
    });
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    record.lastUsedAt = isoNow();
    applyConversation(record, conversation);
    record.acpx = acpxState;
    await flushPendingMessages(false).catch(() => {
      // best effort while process is being interrupted
    });
    output.flush();
    if (ownClient) {
      await client.close();
    }
  };

  try {
    return await runWithOptionalInterrupt({
      handleProcessInterrupts: options.handleProcessInterrupts,
      run: runPrompt,
      handleInterrupt,
    });
  } catch (error) {
    const matchedAcpError = acpErrors.match(error);
    attachAcpErrorPayload(error, matchedAcpError);
    markOutputAlreadyEmitted(error, matchedAcpError !== undefined && shouldMarkAcpErrorsEmitted);
    throw error;
  } finally {
    if (options.verbose) {
      process.stderr.write(`[acpx] ${formatPerfMetric("prompt.total", stopTotalTimer())}\n`);
    } else {
      stopTotalTimer();
    }
    if (notifiedClientAvailable) {
      options.onClientClosed?.();
    }
    client.clearEventHandlers();
    if (ownClient) {
      await client.close();
    }
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    applyConversation(record, conversation);
    record.acpx = acpxState;
    await liveCheckpoint.flush().catch(() => {
      // best effort on close
    });
    await flushPendingMessages(false).catch(() => {
      // best effort on close
    });
    await preserveClosedState().catch(() => {
      // best effort on close
    });
    await closeEventWriter(true).catch(() => {
      // best effort on close
    });
  }
}

export async function runOnce(options: RunOnceOptions): Promise<RunPromptResult> {
  const output = options.outputFormatter;
  const shouldMarkAcpErrorsEmitted = rendersAcpErrors(options.errorEmissionPolicy);
  let promptTurnActive = false;
  let promptTurnHadSideEffects = false;
  const completionTracker = new TurnCompletionTracker();
  const acpErrors = new AcpErrorTracker();
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    agentArgv: options.agentArgv,
    cwd: absolutePath(options.cwd),
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    onAcpMessage: options.onAcpMessage,
    onAcpOutputMessage: (direction, message) => {
      acpErrors.observe(output, direction, message);
    },
    onSessionUpdate: (notification) => {
      completionTracker.observe(notification);
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      options.onSessionUpdate?.(notification);
    },
    onClientOperation: (operation) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      options.onClientOperation?.(operation);
    },
    onPermissionEscalation: (event) => {
      output.onPermissionEscalation(event);
      options.onPermissionEscalation?.(event);
    },
    sessionOptions: options.sessionOptions,
  });

  const runExecPromptAttempt = async (sessionId: string) => {
    acpErrors.reset();
    return await measurePerf("runtime.exec.prompt", async () => {
      return await runPromptTurn({
        client,
        sessionId,
        prompt: options.prompt,
        timeoutMs: options.timeoutMs,
        completionTracker,
        initialDrainIdleMs: oneShotInitialDrainIdleMs(options),
      });
    });
  };

  const runExecPromptWithRetries = async (sessionId: string) => {
    const maxRetries = options.promptRetries ?? 0;
    promptTurnActive = true;
    for (let attempt = 0; ; attempt++) {
      try {
        return await runExecPromptAttempt(sessionId);
      } catch (error) {
        if (shouldRetryPromptAttempt(error, attempt, maxRetries, () => promptTurnHadSideEffects)) {
          await waitBeforePromptRetry(error, attempt, maxRetries, options.suppressSdkConsoleErrors);
          if (!promptTurnHadSideEffects) {
            continue;
          }
        }
        promptTurnActive = false;
        throw error;
      }
    }
  };

  try {
    return await withInterrupt(
      async () => {
        await measurePerf("runtime.exec.start", async () => {
          await withTimeout(client.start(), options.timeoutMs);
        });
        const createdSession = await measurePerf("runtime.exec.create_session", async () => {
          return await withTimeout(
            client.createSession(absolutePath(options.cwd)),
            options.timeoutMs,
          );
        });
        const sessionId = createdSession.sessionId;
        await applyRequestedModelAndEffortIfAdvertised({
          client,
          sessionId,
          requestedModel: options.sessionOptions?.model,
          requestedEffort: options.sessionOptions?.effort,
          models: createdSession.models,
          configOptions: createdSession.configOptions,
          agentCommand: options.agentCommand,
          timeoutMs: options.timeoutMs,
          onWarning: options.suppressSdkConsoleErrors
            ? undefined
            : (message) => process.stderr.write(`[acpx] warning: ${message}\n`),
        });

        output.setContext({
          sessionId,
        });

        const permissionStatsBeforePrompt = client.getPermissionStats();
        const response = await runExecPromptWithRetries(sessionId);
        const permissionStats = permissionStatsDelta(
          client.getPermissionStats(),
          permissionStatsBeforePrompt,
        );
        promptTurnActive = false;
        emitIncompleteTurn(response, output, permissionStats);
        output.flush();
        return toPromptResult(response, sessionId, permissionStats);
      },
      async () => {
        await client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS).catch(() => {
          // Keep flushing and closing even if the adapter cannot acknowledge
          // cancellation during shutdown.
        });
        output.flush();
        await client.close();
      },
    );
  } catch (error) {
    const matchedAcpError = acpErrors.match(error);
    attachAcpErrorPayload(error, matchedAcpError);
    markOutputAlreadyEmitted(error, matchedAcpError !== undefined && shouldMarkAcpErrorsEmitted);
    throw error;
  } finally {
    await client.close();
  }
}

export async function sendSessionDirect(options: SessionSendOptions): Promise<SessionSendResult> {
  return await runSessionPrompt({
    sessionRecordId: options.sessionId,
    prompt: options.prompt,
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    resumePolicy: options.resumePolicy,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    outputFormatter: options.outputFormatter,
    errorEmissionPolicy: options.errorEmissionPolicy,
    onAcpMessage: options.onAcpMessage,
    onSessionUpdate: options.onSessionUpdate,
    onClientOperation: options.onClientOperation,
    onPermissionEscalation: options.onPermissionEscalation,
    timeoutMs: options.timeoutMs,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    client: options.client,
    sessionOptions: options.sessionOptions,
    requestedEffort: options.sessionOptions?.effort,
  });
}

export const sessionRuntimeTestInternals = {
  shouldRetryRuntimePrompt,
  createPendingRequestSink,
  mergeQueuedTaskSessionPreferences,
  oneShotInitialDrainIdleMs,
};
