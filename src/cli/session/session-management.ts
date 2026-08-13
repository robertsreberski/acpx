import { AcpClient, type SessionCreateResult } from "../../acp/client.js";
import { formatErrorMessage } from "../../acp/error-normalization.js";
import { modelStateFromConfigOptions } from "../../acp/model-support.js";
import { withInterrupt, withTimeout } from "../../async-control.js";
import { applyLifecycleSnapshotToRecord } from "../../runtime/engine/lifecycle.js";
import { persistSessionOptions } from "../../runtime/engine/session-options.js";
import { applyConfigOptionsToRecord } from "../../session/config-options.js";
import { createSessionConversation } from "../../session/conversation-model.js";
import { defaultSessionEventLog } from "../../session/event-log.js";
import {
  setCurrentModelId,
  setDesiredEffort,
  syncAdvertisedModelState,
} from "../../session/mode-preference.js";
import {
  applyRequestedModelAndEffortIfAdvertised,
  currentModelIdFromSetModelResponse,
} from "../../session/model-application.js";
import {
  absolutePath,
  findGitRepositoryRoot,
  findSessionByDirectoryWalk,
  isoNow,
  normalizeName,
  writeSessionRecord,
} from "../../session/persistence.js";
import { normalizeRuntimeSessionId } from "../../session/runtime-session-id.js";
import type { SessionEnsureResult, SessionRecord } from "../../types.js";
import { DEFAULT_QUEUE_OWNER_TTL_MS } from "./contracts.js";
import type {
  SessionCreateOptions,
  SessionCreateWithClientResult,
  SessionEnsureOptions,
  SessionListOptions,
  SessionListResult,
} from "./contracts.js";
import { applySessionPreferences, setSessionModel } from "./session-control.js";

type CreatedSessionState = {
  sessionId: string;
  agentSessionId: string | undefined;
  sessionResult: Awaited<ReturnType<AcpClient["createSession" | "loadSession"]>>;
  sessionModels: SessionCreateResult["models"];
  requestedModelApplied: boolean;
  requestedModelResponse?: Awaited<ReturnType<AcpClient["setSessionModel"]>>;
  requestedEffortApplied: boolean;
  requestedEffortConfigId?: string;
  requestedEffortResponse?: Awaited<ReturnType<AcpClient["setSessionConfigOption"]>>;
};

async function applyRequestedCreationPreferences(params: {
  client: AcpClient;
  sessionId: string;
  sessionResult: Pick<SessionCreateResult, "models" | "configOptions">;
  options: SessionCreateOptions;
}) {
  return await applyRequestedModelAndEffortIfAdvertised({
    client: params.client,
    sessionId: params.sessionId,
    requestedModel: params.options.sessionOptions?.model,
    requestedEffort: params.options.sessionOptions?.effort,
    models: params.sessionResult.models,
    configOptions: params.sessionResult.configOptions,
    agentCommand: params.options.agentCommand,
    timeoutMs: params.options.timeoutMs,
    onWarning: params.options.onModelWarning,
  });
}

async function createSessionRecordWithClient(
  client: AcpClient,
  options: SessionCreateOptions,
): Promise<SessionRecord> {
  const cwd = absolutePath(options.cwd);
  await withTimeout(client.start(), options.timeoutMs);
  const createdState = options.resumeSessionId
    ? await resumeSessionRecordWithClient(client, options, cwd)
    : await createFreshSessionState(client, options, cwd);
  const { sessionId, agentSessionId } = createdState;

  const lifecycle = client.getAgentLifecycleSnapshot();
  const now = isoNow();
  const record: SessionRecord = {
    schema: "acpx.session.v1",
    acpxRecordId: sessionId,
    acpSessionId: sessionId,
    agentSessionId,
    agentCommand: options.agentCommand,
    agentArgv: options.agentArgv,
    cwd,
    name: normalizeName(options.name),
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    lastRequestId: undefined,
    eventLog: defaultSessionEventLog(sessionId),
    closed: false,
    closedAt: undefined,
    pid: lifecycle.running ? lifecycle.pid : undefined,
    agentStartedAt: lifecycle.startedAt,
    protocolVersion: client.initializeResult?.protocolVersion,
    agentCapabilities: client.initializeResult?.agentCapabilities,
    ...createSessionConversation(now),
    acpx: {},
  };

  persistSessionOptions(record, options.sessionOptions);
  applyCreatedSessionModelState(record, createdState, options.sessionOptions?.model);

  await writeSessionRecord(record);
  return record;
}

function applyCreatedSessionModelState(
  record: SessionRecord,
  state: CreatedSessionState,
  requestedModel: string | undefined,
): void {
  applyConfigOptionsToRecord(record, state.sessionResult);
  applyConfigOptionsToRecord(record, state.requestedModelResponse);
  applyConfigOptionsToRecord(record, state.requestedEffortResponse);
  const latestConfigResponse = state.requestedEffortResponse ?? state.requestedModelResponse;
  syncAdvertisedModelState(
    record,
    latestConfigResponse
      ? (modelStateFromConfigOptions(latestConfigResponse.configOptions) ?? state.sessionModels)
      : state.sessionModels,
  );
  if (state.requestedModelApplied) {
    setCurrentModelId(
      record,
      currentModelIdFromSetModelResponse(state.requestedModelResponse, requestedModel),
    );
  }
  if (state.requestedEffortApplied) {
    setDesiredEffort(record, record.acpx?.session_options?.effort, state.requestedEffortConfigId);
  }
}

async function createFreshSessionState(
  client: AcpClient,
  options: SessionCreateOptions,
  cwd: string,
): Promise<CreatedSessionState> {
  const createdSession = await withTimeout(client.createSession(cwd), options.timeoutMs);
  const application = await applyRequestedCreationPreferences({
    client,
    sessionId: createdSession.sessionId,
    sessionResult: createdSession,
    options,
  });
  return {
    sessionId: createdSession.sessionId,
    agentSessionId: normalizeRuntimeSessionId(createdSession.agentSessionId),
    sessionResult: createdSession,
    sessionModels: createdSession.models,
    requestedModelApplied: application.model.applied,
    requestedModelResponse: application.model.response,
    requestedEffortApplied: application.effort.applied,
    requestedEffortConfigId: application.effort.configId,
    requestedEffortResponse: application.effort.response,
  };
}

async function resumeSessionRecordWithClient(
  client: AcpClient,
  options: SessionCreateOptions,
  cwd: string,
): Promise<CreatedSessionState> {
  if (!options.resumeSessionId) {
    throw new Error("resumeSessionId is required");
  }
  const resumeMethod = client.supportsResumeSession()
    ? "session/resume"
    : client.supportsLoadSession()
      ? "session/load"
      : undefined;
  if (!resumeMethod) {
    throw new Error(
      `Agent command "${options.agentCommand}" does not support session/resume or session/load; cannot resume session ${options.resumeSessionId}`,
    );
  }

  try {
    const resumedSession = await withTimeout(
      resumeMethod === "session/resume"
        ? client.resumeSession(options.resumeSessionId, cwd)
        : client.loadSession(options.resumeSessionId, cwd),
      options.timeoutMs,
    );
    const sessionModels = resumedSession.models;
    const application = await applyRequestedCreationPreferences({
      client,
      sessionId: options.resumeSessionId,
      sessionResult: resumedSession,
      options,
    });
    return {
      sessionId: options.resumeSessionId,
      agentSessionId: normalizeRuntimeSessionId(resumedSession.agentSessionId),
      sessionResult: resumedSession,
      sessionModels,
      requestedModelApplied: application.model.applied,
      requestedModelResponse: application.model.response,
      requestedEffortApplied: application.effort.applied,
      requestedEffortConfigId: application.effort.configId,
      requestedEffortResponse: application.effort.response,
    };
  } catch (error) {
    throw new Error(
      `Failed to resume ACP session ${options.resumeSessionId}: ${formatErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

export async function createSessionWithClient(
  options: SessionCreateOptions,
): Promise<SessionCreateWithClientResult> {
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
    verbose: options.verbose,
    sessionOptions: options.sessionOptions,
  });

  try {
    const record = await withInterrupt(
      async () => await createSessionRecordWithClient(client, options),
      async () => {
        await client.close();
      },
    );

    return {
      record,
      client,
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function createSession(options: SessionCreateOptions): Promise<SessionRecord> {
  const { record, client } = await createSessionWithClient(options);
  try {
    return record;
  } finally {
    await client.close();
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    await writeSessionRecord(record);
  }
}

export async function listAgentSessions(options: SessionListOptions): Promise<SessionListResult> {
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
    verbose: options.verbose,
  });

  try {
    return await withInterrupt(
      async () => {
        await withTimeout(client.start(), options.timeoutMs);
        if (!client.supportsListSessions()) {
          return undefined;
        }

        const cwd = options.filterCwd ? absolutePath(options.filterCwd) : undefined;
        const response = await withTimeout(
          client.listSessions({
            ...(cwd ? { cwd } : {}),
            ...(options.cursor ? { cursor: options.cursor } : {}),
          }),
          options.timeoutMs,
        );

        return {
          _meta: response._meta,
          source: "agent",
          sessions: response.sessions,
          cursor: options.cursor,
          cwd,
          nextCursor: response.nextCursor,
        };
      },
      async () => {
        await client.close();
      },
    );
  } finally {
    await client.close();
  }
}

export async function ensureSession(options: SessionEnsureOptions): Promise<SessionEnsureResult> {
  const cwd = absolutePath(options.cwd);
  const gitRoot = findGitRepositoryRoot(cwd);
  const walkBoundary = options.walkBoundary ?? gitRoot ?? cwd;
  const existing = await findSessionByDirectoryWalk({
    agentCommand: options.agentCommand,
    cwd,
    name: options.name,
    boundary: walkBoundary,
  });
  if (existing) {
    return {
      record: await applyEnsureSessionPreferences(existing, options),
      created: false,
    };
  }

  const record = await createSession({
    agentCommand: options.agentCommand,
    agentArgv: options.agentArgv,
    cwd,
    name: options.name,
    resumeSessionId: options.resumeSessionId,
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
    sessionOptions: options.sessionOptions,
  });

  return {
    record,
    created: true,
  };
}

async function applyEnsureSessionPreferences(
  existing: SessionRecord,
  options: SessionEnsureOptions,
): Promise<SessionRecord> {
  const requestedModel = options.sessionOptions?.model;
  const requestedEffort = options.sessionOptions?.effort;
  if (requestedEffort) {
    return await applyEnsuredPreferences(existing, requestedModel, requestedEffort, options);
  }
  return requestedModel ? await applyEnsuredModel(existing, requestedModel, options) : existing;
}

async function applyEnsuredModel(
  existing: SessionRecord,
  requestedModel: string,
  options: SessionEnsureOptions,
): Promise<SessionRecord> {
  const result = await setSessionModel({
    sessionId: existing.acpxRecordId,
    modelId: requestedModel,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
  return result.record;
}

async function applyEnsuredPreferences(
  record: SessionRecord,
  requestedModel: string | undefined,
  requestedEffort: string,
  options: SessionEnsureOptions,
): Promise<SessionRecord> {
  const result = await applySessionPreferences({
    sessionId: record.acpxRecordId,
    modelId: requestedModel,
    effort: requestedEffort,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
    onModelWarning: options.onModelWarning,
  });
  return result.record;
}

export { DEFAULT_QUEUE_OWNER_TTL_MS };
