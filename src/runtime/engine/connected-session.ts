import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { AcpClient } from "../../acp/client.js";
import { effortStateFromConfigOptions } from "../../acp/effort-support.js";
import { withInterrupt } from "../../async-control.js";
import { applyConfigOptionsToRecord } from "../../session/config-options.js";
import { cloneSessionAcpxState } from "../../session/conversation-model.js";
import { setCurrentModelId, setDesiredModelId } from "../../session/mode-preference.js";
import {
  applyRequestedModelAndEffortIfAdvertised,
  applyRequestedModelPreferenceToRecord,
  applyRequestedPreferencesToRecord,
  clearDesiredEffortAfterUnrefreshedModelChange,
  currentModelIdFromSetModelResponse,
  reapplyDesiredEffortAfterModelChange,
} from "../../session/model-application.js";
import { advertisedModelState } from "../../session/model-state.js";
import { absolutePath, isoNow } from "../../session/persistence.js";
import type {
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpPermissionRequestContext,
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  PermissionEscalationEvent,
  PermissionMode,
  PermissionPolicy,
  SessionRecord,
  SessionResumePolicy,
} from "../../types.js";
import { applyLifecycleSnapshotToRecord } from "./lifecycle.js";
import { connectAndLoadSession, type ConnectedSessionController } from "./reconnect.js";
import { sessionOptionsFromRecord } from "./session-options.js";

export type FullConnectedSessionController = ConnectedSessionController & {
  setSessionModel: (modelId: string) => Promise<SetSessionConfigOptionResponse | undefined>;
  setSessionConfigOption: (
    configId: string,
    value: string,
  ) => Promise<SetSessionConfigOptionResponse>;
  applySessionPreferences: (
    modelId: string | undefined,
    effort: string,
  ) => Promise<{
    effortConfigId: string;
    response: SetSessionConfigOptionResponse;
  }>;
};

type ConnectedSessionContext = {
  record: SessionRecord;
  client: AcpClient;
  activeController: FullConnectedSessionController;
  sessionId: string;
  resumed: boolean;
  loadError?: string;
};

export type WithConnectedSessionOptions<T> = {
  sessionRecordId: string;
  loadRecord: (sessionRecordId: string) => Promise<SessionRecord>;
  saveRecord: (record: SessionRecord) => Promise<void>;
  createClient?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
  mcpServers?: McpServer[];
  permissionMode?: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: PermissionPolicy;
  onPermissionEscalation?: (event: PermissionEscalationEvent) => void;
  onPermissionRequest?: (
    req: AcpPermissionRequest,
    ctx: AcpPermissionRequestContext,
  ) => Promise<AcpPermissionDecision | undefined>;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  fs?: boolean;
  terminal?: boolean;
  resumePolicy?: SessionResumePolicy;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: FullConnectedSessionController) => void;
  onClientClosed?: () => void;
  onConnectedRecord?: (record: SessionRecord) => void;
  onInterrupt?: (params: { client: AcpClient; record: SessionRecord }) => Promise<void>;
  run: (context: ConnectedSessionContext) => Promise<T>;
};

export type WithConnectedSessionResult<T> = {
  value: T;
  record: SessionRecord;
  resumed: boolean;
  loadError?: string;
};

function createActiveSessionController(params: {
  client: AcpClient;
  record: SessionRecord;
  getActiveSessionId: () => string;
}): FullConnectedSessionController {
  const getActiveSessionId = () => params.getActiveSessionId();
  return {
    hasActivePrompt: () => params.client.hasActivePrompt(),
    requestCancelActivePrompt: async () => await params.client.requestCancelActivePrompt(),
    setSessionMode: async (modeId: string) => {
      await params.client.setSessionMode(getActiveSessionId(), modeId);
    },
    setSessionModel: async (modelId: string) => {
      const previousState = cloneSessionAcpxState(params.record.acpx);
      const models = advertisedModelState(params.record.acpx);
      const response = await params.client.setSessionModel(getActiveSessionId(), modelId, models);
      applyConfigOptionsToRecord(params.record, response);
      setDesiredModelId(params.record, modelId, models?.configId);
      setCurrentModelId(params.record, currentModelIdFromSetModelResponse(response, modelId));
      if (!response) {
        params.record.acpx = clearDesiredEffortAfterUnrefreshedModelChange({
          state: params.record.acpx,
          modelResponse: response,
          previousModelId: models?.currentModelId,
          requestedModelId: modelId,
          previousEffortConfigId: effortStateFromConfigOptions(previousState?.config_options)
            ?.configId,
        });
        return response;
      }
      const effort = await reapplyDesiredEffortAfterModelChange({
        client: params.client,
        sessionId: getActiveSessionId(),
        previousState,
        nextState: params.record.acpx,
        onReconciledState: (state) => {
          params.record.acpx = state;
        },
      });
      params.record.acpx = effort.state;
      return effort.response ?? response;
    },
    setSessionConfigOption: async (configId: string, value: string) => {
      const previousState = cloneSessionAcpxState(params.record.acpx);
      const modelConfigId = advertisedModelState(params.record.acpx)?.configId;
      const response = await params.client.setSessionConfigOption(
        getActiveSessionId(),
        configId,
        value,
      );
      applyConfigOptionsToRecord(params.record, response);
      if (configId !== modelConfigId) {
        return response;
      }
      setDesiredModelId(params.record, value, configId);
      setCurrentModelId(params.record, currentModelIdFromSetModelResponse(response, value));
      const effort = await reapplyDesiredEffortAfterModelChange({
        client: params.client,
        sessionId: getActiveSessionId(),
        previousState,
        nextState: params.record.acpx,
        onReconciledState: (state) => {
          params.record.acpx = state;
        },
      });
      params.record.acpx = effort.state;
      return effort.response ?? response;
    },
    applySessionPreferences: async (modelId: string | undefined, effort: string) => {
      const models = advertisedModelState(params.record.acpx);
      const previousEffortConfigId = effortStateFromConfigOptions(
        params.record.acpx?.config_options,
      )?.configId;
      const application = await applyRequestedModelAndEffortIfAdvertised({
        client: params.client,
        sessionId: getActiveSessionId(),
        requestedModel: modelId,
        requestedEffort: effort,
        models,
        configOptions: params.record.acpx?.config_options,
        agentCommand: params.record.agentCommand,
        onModelApplied: (modelApplication) => {
          applyRequestedModelPreferenceToRecord({
            record: params.record,
            application: modelApplication,
            requestedModel: modelId,
            initialModels: models,
            previousEffortConfigId,
            replacesEffort: true,
          });
        },
      });
      const effortConfigId = applyRequestedPreferencesToRecord({
        record: params.record,
        application,
        requestedModel: modelId,
        requestedEffort: effort,
        initialModels: models,
        previousEffortConfigId,
      });
      return {
        effortConfigId,
        response: application.effort.response ??
          application.model.response ?? {
            configOptions: structuredClone(params.record.acpx?.config_options ?? []),
          },
      };
    },
  };
}

export async function withConnectedSession<T>(
  options: WithConnectedSessionOptions<T>,
): Promise<WithConnectedSessionResult<T>> {
  const record = await options.loadRecord(options.sessionRecordId);
  const client =
    options.createClient?.({
      agentCommand: record.agentCommand,
      agentArgv: record.agentArgv,
      cwd: absolutePath(record.cwd),
      mcpServers: options.mcpServers,
      permissionMode: options.permissionMode ?? "approve-reads",
      nonInteractivePermissions: options.nonInteractivePermissions,
      permissionPolicy: options.permissionPolicy,
      onPermissionEscalation: options.onPermissionEscalation,
      onPermissionRequest: options.onPermissionRequest,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      fs: options.fs,
      terminal: options.terminal,
      verbose: options.verbose,
      sessionOptions: sessionOptionsFromRecord(record),
    }) ??
    new AcpClient({
      agentCommand: record.agentCommand,
      agentArgv: record.agentArgv,
      cwd: absolutePath(record.cwd),
      mcpServers: options.mcpServers,
      permissionMode: options.permissionMode ?? "approve-reads",
      nonInteractivePermissions: options.nonInteractivePermissions,
      permissionPolicy: options.permissionPolicy,
      onPermissionEscalation: options.onPermissionEscalation,
      onPermissionRequest: options.onPermissionRequest,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      fs: options.fs,
      terminal: options.terminal,
      verbose: options.verbose,
      sessionOptions: sessionOptionsFromRecord(record),
    });
  let activeSessionIdForControl = record.acpSessionId;
  let notifiedClientAvailable = false;
  const activeController = createActiveSessionController({
    client,
    record,
    getActiveSessionId: () => activeSessionIdForControl,
  });

  try {
    return await withInterrupt(
      async () => {
        const { sessionId, resumed, loadError } = await connectAndLoadSession({
          client,
          record,
          resumePolicy: options.resumePolicy,
          timeoutMs: options.timeoutMs,
          verbose: options.verbose,
          activeController,
          onClientAvailable: () => {
            options.onClientAvailable?.(activeController);
            notifiedClientAvailable = true;
          },
          onConnectedRecord: options.onConnectedRecord,
          onSessionIdResolved: (sessionIdValue) => {
            activeSessionIdForControl = sessionIdValue;
          },
        });

        const value = await options.run({
          record,
          client,
          activeController,
          sessionId,
          resumed,
          loadError,
        });

        const now = isoNow();
        record.lastUsedAt = now;
        record.closed = false;
        record.closedAt = undefined;
        record.protocolVersion = client.initializeResult?.protocolVersion;
        record.agentCapabilities = client.initializeResult?.agentCapabilities;
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        await options.saveRecord(record);

        return {
          value,
          record,
          resumed,
          loadError,
        };
      },
      async () => {
        if (options.onInterrupt) {
          await options.onInterrupt({ client, record });
        } else {
          await client.cancelActivePrompt(2_500);
        }
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        record.lastUsedAt = isoNow();
        await options.saveRecord(record).catch(() => {
          // best effort while process is being interrupted
        });
        await client.close();
      },
    );
  } finally {
    if (notifiedClientAvailable) {
      options.onClientClosed?.();
    }
    await client.close();
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    await options.saveRecord(record).catch(() => {
      // best effort on close
    });
  }
}
