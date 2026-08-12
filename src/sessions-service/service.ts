import { randomUUID } from "node:crypto";
import {
  mergeAgentRegistry,
  normalizeAgentName,
  resolveAgentArgv,
  resolveCanonicalAgentName,
} from "../agent-registry.js";
import { withTimeout } from "../async-control.js";
import { loadResolvedConfig, type ResolvedAcpxConfig } from "../cli/config.js";
import { createOutputFormatter } from "../cli/output/output.js";
import {
  isQueueAdmissionOutcomeUnknown,
  tryListRequestsOnRunningOwner,
  tryRespondOnRunningOwner,
} from "../cli/queue/ipc.js";
import { readLiveQueueOwner, readQueueOwnerRecord } from "../cli/queue/lease-store.js";
import { queueOwnerSpawnArgsForModule } from "../cli/session/queue-owner-process.js";
import { sendSession } from "../cli/session/queue-owner-runtime.js";
import {
  cancelSessionPrompt,
  closeSession as closeOwnedSession,
  setSessionMode,
} from "../cli/session/session-control.js";
import { createSessionWithClient, listAgentSessions } from "../cli/session/session-management.js";
import { PendingRequestOwnerGoneError, SessionNotFoundError } from "../errors.js";
import { textPrompt } from "../prompt-content.js";
import { applyLifecycleSnapshotToRecord } from "../runtime/engine/lifecycle.js";
import { setDesiredModeId } from "../session/mode-preference.js";
import {
  listPendingRequests as listStoredPendingRequests,
  readPendingRequest,
  sweepPendingRequests,
  type PendingRequest,
} from "../session/pending-requests.js";
import { listSessions, writeSessionRecord } from "../session/persistence.js";
import {
  appendSessionTimelineLifecycleEvent,
  getActiveSessionTimelineTurn,
  listSessionTimelinePage,
} from "../session/timeline.js";
import type { PermissionPolicy, SessionRecord } from "../types.js";
import type {
  AcpxAdoptSessionInput,
  AcpxCancelTurnInput,
  AcpxCancelTurnResult,
  AcpxCloseSessionInput,
  AcpxCreateSessionInput,
  AcpxEnqueuePromptInput,
  AcpxEnqueuePromptResult,
  AcpxMutationReceipt,
  AcpxPendingRequest,
  AcpxProviderSessionPage,
  AcpxRegisteredAgent,
  AcpxRespondPendingRequestInput,
  AcpxSessionDetail,
  AcpxSessionInvalidation,
  AcpxSessionService,
  AcpxSessionSummary,
  AcpxSessionsServiceOptions,
  AcpxTranscriptPage,
} from "./contract.js";
import { runIdempotentMutation } from "./idempotency.js";
import { projectPendingRequest, projectRegisteredAgents, projectSession } from "./projection.js";

const DEFAULT_TIMELINE_POLL_MS = 500;
const DEFAULT_ADAPTER_OPERATION_TIMEOUT_MS = 60_000;
const LIVE_PENDING_LIST_TIMEOUT_MS = 2_000;
const DEFAULT_PENDING_RESPONSE_TIMEOUT_MS = 60_000;
const DEFAULT_DEFER_MAX_AGE_MS = 86_400_000;
const NO_LIVE_OWNER_GENERATION = 0;
const SESSION_SERVICE_QUEUE_OWNER_ARGS = queueOwnerSpawnArgsForModule(import.meta.url);

/** Browser-created sessions stop at the human boundary unless a caller opts into another policy. */
export const DEFAULT_SESSIONS_PERMISSION_POLICY: Readonly<PermissionPolicy> = {
  autoApprove: ["read", "search"],
  defaultAction: "defer",
};

type ResolvedAgent = {
  agentId: string;
  agentCommand: string;
  agentArgv?: string[];
  config: ResolvedAcpxConfig;
};

type StartSessionCheckpoint = {
  recordId: string;
  phase: "created" | "configured";
};

function parseStartSessionCheckpoint(value: unknown): StartSessionCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid persisted session-start recovery checkpoint");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.recordId !== "string" ||
    (record.phase !== "created" && record.phase !== "configured")
  ) {
    throw new Error("Invalid persisted session-start recovery checkpoint");
  }
  return { recordId: record.recordId, phase: record.phase };
}

export class AcpxAgentCapabilityError extends Error {
  readonly code = "AGENT_CAPABILITY_UNSUPPORTED";

  constructor(agentId: string, capability: string) {
    super(`Agent ${agentId} does not advertise ${capability}`);
    this.name = "AcpxAgentCapabilityError";
  }
}

export class AcpxAgentNotRegisteredError extends Error {
  readonly code = "AGENT_NOT_REGISTERED";

  constructor(agentId: string) {
    super(`Agent ${JSON.stringify(agentId)} is not registered in acpx configuration`);
    this.name = "AcpxAgentNotRegisteredError";
  }
}

export class AcpxSessionAdoptionError extends Error {
  readonly code = "SESSION_ADOPTION_FAILED";

  constructor(agentId: string, providerSessionId: string, cause: unknown) {
    super(
      `Agent ${agentId} could not strictly adopt provider session ${providerSessionId}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    );
    this.name = "AcpxSessionAdoptionError";
  }
}

export class AcpxTurnConflictError extends Error {
  readonly code = "TURN_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "AcpxTurnConflictError";
  }
}

export class AcpxTurnNotActiveError extends Error {
  readonly code = "TURN_NOT_ACTIVE";

  constructor(turnId: string, activeTurnId: string | undefined) {
    super(
      activeTurnId
        ? `Turn ${turnId} is not active; the active turn is ${activeTurnId}`
        : `Turn ${turnId} is not active`,
    );
    this.name = "AcpxTurnNotActiveError";
  }
}

function cloneDefaultPolicy(): PermissionPolicy {
  return { autoApprove: ["read", "search"], defaultAction: "defer" };
}

function adapterOperationTimeout(
  options: AcpxSessionsServiceOptions,
  config: ResolvedAcpxConfig,
): number {
  return (
    options.adapterOperationTimeoutMs ?? config.timeoutMs ?? DEFAULT_ADAPTER_OPERATION_TIMEOUT_MS
  );
}

function customCommands(config: ResolvedAcpxConfig): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config.agents).map(([name, invocation]) => [name, invocation.command]),
  );
}

function configuredAgentArgv(agentId: string, config: ResolvedAcpxConfig): string[] | undefined {
  const canonical = resolveCanonicalAgentName(agentId);
  const configured = config.agents[agentId] ?? config.agents[canonical];
  if (configured) {
    return configured.argv ? [...configured.argv] : undefined;
  }
  return resolveAgentArgv(canonical);
}

function registeredAgent(
  agentId: string,
  registry: Record<string, string>,
): { agentId: string; agentCommand: string } | undefined {
  const normalized = normalizeAgentName(agentId);
  const key = Object.hasOwn(registry, normalized)
    ? normalized
    : resolveCanonicalAgentName(normalized);
  const agentCommand = registry[key];
  return agentCommand ? { agentId: key, agentCommand } : undefined;
}

function defaultMode(agentId: string): string | undefined {
  switch (resolveCanonicalAgentName(agentId)) {
    case "codex":
      return "read-only";
    case "claude":
      return "default";
    default:
      return undefined;
  }
}

function exactRecord(records: SessionRecord[], acpxRecordId: string): SessionRecord | undefined {
  return records.find((record) => record.acpxRecordId === acpxRecordId);
}

function providerSessionProjection(session: {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
}): AcpxProviderSessionPage["sessions"][number] {
  return {
    providerSessionId: session.sessionId,
    cwd: session.cwd,
    title: session.title ?? undefined,
    updatedAt: session.updatedAt ?? undefined,
  };
}

function pendingRequestSort(left: PendingRequest, right: PendingRequest): number {
  return (
    left.createdAt.localeCompare(right.createdAt) || left.requestId.localeCompare(right.requestId)
  );
}

function mergePending(stored: PendingRequest[], live: PendingRequest[]): PendingRequest[] {
  const ids = new Set(stored.map((entry) => entry.requestId));
  return [...stored, ...live.filter((entry) => !ids.has(entry.requestId))].toSorted(
    pendingRequestSort,
  );
}

function pendingFingerprint(entries: PendingRequest[]): string {
  return entries
    .map((entry) => `${entry.requestId}:${entry.state}:${entry.resolution?.answeredAt ?? ""}`)
    .toSorted()
    .join("|");
}

// oxlint-disable-next-line eslint/complexity -- The fingerprint intentionally covers independent persisted and owner axes.
function recordFingerprint(
  record: SessionRecord,
  owner: Awaited<ReturnType<typeof readQueueOwnerRecord>>,
): string {
  return [
    record.lastUsedAt,
    record.closed === true ? "closed" : "open",
    record.timeline?.epoch ?? "",
    record.timeline?.last_seq ?? 0,
    owner?.ownerGeneration ?? "",
    owner?.queueDepth ?? 0,
    owner?.heartbeatAt ?? "",
  ].join(":");
}

class SessionService implements AcpxSessionService {
  private readonly options: AcpxSessionsServiceOptions;
  private readonly listeners = new Set<(event: AcpxSessionInvalidation) => void>();
  private pollTimer: NodeJS.Timeout | undefined;
  private pollBusy = false;
  private pollingInitialized = false;
  private readonly observedRecords = new Map<string, string>();
  private readonly observedPending = new Map<string, string>();

  constructor(options: AcpxSessionsServiceOptions) {
    this.options = options;
  }

  private async config(cwd: string): Promise<ResolvedAcpxConfig> {
    return await loadResolvedConfig(cwd, { mcpConfigPath: this.options.mcpConfigPath });
  }

  private async resolveAgent(agentId: string, cwd: string): Promise<ResolvedAgent> {
    const config = await this.config(cwd);
    const registry = mergeAgentRegistry(customCommands(config));
    const registered = registeredAgent(agentId, registry);
    if (!registered) {
      throw new AcpxAgentNotRegisteredError(agentId);
    }
    return {
      agentId: registered.agentId,
      agentCommand: registered.agentCommand,
      agentArgv: configuredAgentArgv(registered.agentId, config),
      config,
    };
  }

  private async requireExactRecord(acpxRecordId: string): Promise<SessionRecord> {
    const record = exactRecord(await listSessions(), acpxRecordId);
    if (!record) {
      throw new SessionNotFoundError(acpxRecordId);
    }
    return record;
  }

  private async registry(cwd: string): Promise<Record<string, string>> {
    return mergeAgentRegistry(customCommands(await this.config(cwd)));
  }

  private adapterTimeout(config: ResolvedAcpxConfig): number {
    return adapterOperationTimeout(this.options, config);
  }

  private async projectDetail(record: SessionRecord): Promise<AcpxSessionDetail> {
    return await projectSession(record, true, await this.registry(record.cwd));
  }

  private async projectSummary(record: SessionRecord): Promise<AcpxSessionSummary> {
    return await projectSession(record, false, await this.registry(record.cwd));
  }

  private emit(event: AcpxSessionInvalidation): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One embedding consumer must not disable invalidations for every other consumer.
      }
    }
  }

  async listAgents(): Promise<AcpxRegisteredAgent[]> {
    const cwd = this.options.cwd ?? process.cwd();
    const [config, records] = await Promise.all([this.config(cwd), listSessions()]);
    return projectRegisteredAgents(mergeAgentRegistry(customCommands(config)), records);
  }

  async listSessions(): Promise<AcpxSessionSummary[]> {
    const records = await listSessions();
    return await Promise.all(records.map(async (record) => await this.projectSummary(record)));
  }

  async getSession(input: { acpxRecordId: string }): Promise<AcpxSessionDetail | undefined> {
    const record = exactRecord(await listSessions(), input.acpxRecordId);
    return record ? await this.projectDetail(record) : undefined;
  }

  async listProviderSessions(input: {
    agentId: string;
    cwd?: string;
    cursor?: string;
  }): Promise<AcpxProviderSessionPage> {
    const cwd = input.cwd ?? this.options.cwd ?? process.cwd();
    const agent = await this.resolveAgent(input.agentId, cwd);
    const response = await listAgentSessions({
      agentCommand: agent.agentCommand,
      agentArgv: agent.agentArgv,
      cwd,
      filterCwd: cwd,
      cursor: input.cursor,
      mcpServers: agent.config.mcpServers,
      permissionMode: agent.config.defaultPermissions,
      nonInteractivePermissions:
        this.options.nonInteractivePermissions ?? agent.config.nonInteractivePermissions,
      authCredentials: { ...agent.config.auth, ...this.options.authCredentials },
      authPolicy: this.options.authPolicy ?? agent.config.authPolicy,
      timeoutMs: this.adapterTimeout(agent.config),
    });
    if (!response) {
      throw new AcpxAgentCapabilityError(agent.agentId, "session/list");
    }
    return {
      sessions: response.sessions.map(providerSessionProjection),
      nextCursor: response.nextCursor ?? undefined,
    };
  }

  // oxlint-disable-next-line eslint/complexity -- This is the create/adopt transaction boundary and keeps teardown in one finally.
  private async startSession(
    input: AcpxCreateSessionInput,
    providerSessionId?: string,
    checkpoint?: (value: StartSessionCheckpoint) => Promise<void>,
  ): Promise<AcpxSessionDetail> {
    const agent = await this.resolveAgent(input.agentId, input.cwd);
    if (providerSessionId) {
      const candidates = (await listSessions()).filter(
        (record) => record.acpSessionId === providerSessionId,
      );
      const existing =
        candidates.find((record) => record.acpx?.agent_id === agent.agentId) ??
        candidates.find(
          (record) =>
            record.acpx?.agent_id === undefined && record.agentCommand === agent.agentCommand,
        );
      if (existing) {
        if (existing.acpx?.agent_id === undefined) {
          existing.acpx = { ...existing.acpx, agent_id: agent.agentId };
          await writeSessionRecord(existing);
        }
        return await this.projectDetail(existing);
      }
      if (candidates.length > 0) {
        const owner = candidates[0]?.acpx?.agent_id;
        throw new AcpxSessionAdoptionError(
          agent.agentId,
          providerSessionId,
          new Error(
            owner
              ? `provider session is already adopted by agent ${JSON.stringify(owner)}`
              : "provider session is already adopted by an unverified agent command",
          ),
        );
      }
    }

    let created: Awaited<ReturnType<typeof createSessionWithClient>>;
    try {
      created = await createSessionWithClient({
        acpxRecordId: randomUUID(),
        agentCommand: agent.agentCommand,
        agentArgv: agent.agentArgv,
        cwd: input.cwd,
        name: input.name,
        resumeSessionId: providerSessionId,
        mcpServers: agent.config.mcpServers,
        permissionMode: input.permissionMode ?? agent.config.defaultPermissions,
        nonInteractivePermissions:
          this.options.nonInteractivePermissions ?? agent.config.nonInteractivePermissions,
        permissionPolicy: input.permissionPolicy,
        authCredentials: { ...agent.config.auth, ...this.options.authCredentials },
        authPolicy: this.options.authPolicy ?? agent.config.authPolicy,
        timeoutMs: this.adapterTimeout(agent.config),
        sessionOptions: input.model ? { model: input.model } : undefined,
      });
    } catch (error) {
      if (providerSessionId) {
        throw new AcpxSessionAdoptionError(agent.agentId, providerSessionId, error);
      }
      throw error;
    }
    const { record, client } = created;
    try {
      record.acpx = { ...record.acpx, agent_id: agent.agentId };
      await writeSessionRecord(record);
      await checkpoint?.({ recordId: record.acpxRecordId, phase: "created" });
      const mode = input.mode ?? defaultMode(agent.agentId);
      if (mode) {
        await withTimeout(
          client.setSessionMode(record.acpSessionId, mode),
          this.adapterTimeout(agent.config),
        );
        setDesiredModeId(record, mode);
        record.acpx = { ...record.acpx, current_mode_id: mode };
      }
      await writeSessionRecord(record);
      await checkpoint?.({ recordId: record.acpxRecordId, phase: "configured" });
    } finally {
      await client.close();
      applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
      await writeSessionRecord(record);
    }
    return await this.projectDetail(record);
  }

  // oxlint-disable-next-line eslint/complexity -- Recovery validates identity and resumes only the unfinished phase.
  private async recoverStartedSession(
    input: AcpxCreateSessionInput,
    checkpointValue: unknown,
    providerSessionId?: string,
  ): Promise<AcpxSessionDetail> {
    const checkpoint = parseStartSessionCheckpoint(checkpointValue);
    const [agent, record] = await Promise.all([
      this.resolveAgent(input.agentId, input.cwd),
      this.requireExactRecord(checkpoint.recordId),
    ]);
    if (
      record.agentCommand !== agent.agentCommand ||
      (providerSessionId !== undefined && record.acpSessionId !== providerSessionId)
    ) {
      throw new Error(
        `Persisted session-start checkpoint does not match the requested session ` +
          `(record command ${JSON.stringify(record.agentCommand)}, requested command ${JSON.stringify(agent.agentCommand)}, ` +
          `record provider ${JSON.stringify(record.acpSessionId)}, requested provider ${JSON.stringify(providerSessionId)})`,
      );
    }
    if (checkpoint.phase === "created") {
      const mode = input.mode ?? defaultMode(agent.agentId);
      if (mode) {
        await setSessionMode({
          sessionId: record.acpxRecordId,
          modeId: mode,
          mcpServers: agent.config.mcpServers,
          nonInteractivePermissions:
            this.options.nonInteractivePermissions ?? agent.config.nonInteractivePermissions,
          authCredentials: { ...agent.config.auth, ...this.options.authCredentials },
          authPolicy: this.options.authPolicy ?? agent.config.authPolicy,
          timeoutMs: this.adapterTimeout(agent.config),
        });
      }
    }
    return await this.projectDetail(await this.requireExactRecord(checkpoint.recordId));
  }

  async createSession(
    input: AcpxCreateSessionInput,
  ): Promise<AcpxMutationReceipt<AcpxSessionDetail>> {
    const receipt = await runIdempotentMutation({
      operation: "create_session",
      idempotencyKey: input.idempotencyKey,
      input,
      recover: async (checkpoint) => await this.recoverStartedSession(input, checkpoint),
      run: async (checkpoint) => await this.startSession(input, undefined, checkpoint),
    });
    this.emit({ type: "sessions", acpxRecordId: receipt.result.acpxRecordId });
    return receipt;
  }

  async adoptSession(
    input: AcpxAdoptSessionInput,
  ): Promise<AcpxMutationReceipt<AcpxSessionDetail>> {
    const receipt = await runIdempotentMutation({
      operation: "adopt_session",
      idempotencyKey: input.idempotencyKey,
      input,
      recover: async (checkpoint) =>
        await this.recoverStartedSession(input, checkpoint, input.providerSessionId),
      run: async (checkpoint) =>
        await this.startSession(input, input.providerSessionId, checkpoint),
    });
    this.emit({ type: "sessions", acpxRecordId: receipt.result.acpxRecordId });
    return receipt;
  }

  async enqueuePrompt(
    input: AcpxEnqueuePromptInput,
  ): Promise<AcpxMutationReceipt<AcpxEnqueuePromptResult>> {
    const turnId = randomUUID();
    const unknown: AcpxEnqueuePromptResult = { turnId, admission: "unknown" };
    const receipt = await runIdempotentMutation({
      operation: "enqueue_prompt",
      idempotencyKey: input.idempotencyKey,
      input,
      recoveryResult: unknown,
      outcomeUnknown: isQueueAdmissionOutcomeUnknown,
      // oxlint-disable-next-line eslint/complexity -- Queue admission must assemble the complete existing send contract atomically.
      run: async () => {
        const record = await this.requireExactRecord(input.acpxRecordId);
        if (record.closed === true) {
          throw new AcpxTurnConflictError(`Session ${record.acpxRecordId} is closed`);
        }
        const config = await this.config(record.cwd);
        await appendSessionTimelineLifecycleEvent(
          record,
          { type: "turn_submitted" },
          { turnId, requestId: turnId },
        );
        let result: Awaited<ReturnType<typeof sendSession>>;
        try {
          result = await sendSession({
            sessionId: record.acpxRecordId,
            turnId,
            prompt: typeof input.prompt === "string" ? textPrompt(input.prompt) : input.prompt,
            mcpServers: config.mcpServers,
            mcpConfigPath: config.mcpConfigPath,
            mcpConfigFingerprint: config.mcpConfigFingerprint,
            permissionMode: input.permissionMode ?? config.defaultPermissions,
            nonInteractivePermissions:
              this.options.nonInteractivePermissions ?? config.nonInteractivePermissions,
            permissionPolicy: input.permissionPolicy ?? cloneDefaultPolicy(),
            authCredentials: { ...config.auth, ...this.options.authCredentials },
            authPolicy: this.options.authPolicy ?? config.authPolicy,
            outputFormatter: createOutputFormatter("quiet", {
              stdout: { write() {} },
              stderr: { write() {} },
            }),
            suppressSdkConsoleErrors: true,
            queueOwnerSpawnArgs: SESSION_SERVICE_QUEUE_OWNER_ARGS,
            timeoutMs: config.timeoutMs,
            ttlMs: config.ttlMs,
            defer: true,
            deferMaxAgeMs: input.deferMaxAgeMs ?? DEFAULT_DEFER_MAX_AGE_MS,
            maxQueueDepth: config.queueMaxDepth,
            waitForCompletion: false,
            sessionOptions: record.acpx?.session_options
              ? {
                  model: record.acpx.session_options.model,
                  allowedTools: record.acpx.session_options.allowed_tools,
                  maxTurns: record.acpx.session_options.max_turns,
                  systemPrompt: record.acpx.session_options.system_prompt,
                  env: record.acpx.session_options.env,
                }
              : undefined,
          });
        } catch (error) {
          if (!isQueueAdmissionOutcomeUnknown(error)) {
            await appendSessionTimelineLifecycleEvent(
              record,
              {
                type: "turn_failed",
                message: error instanceof Error ? error.message : String(error),
              },
              { turnId, requestId: turnId },
            );
          }
          throw error;
        }
        const admission: AcpxEnqueuePromptResult["admission"] =
          "queued" in result ? "queued" : "started";
        return { turnId, admission };
      },
    });
    this.emit({ type: "session", acpxRecordId: input.acpxRecordId });
    this.emit({ type: "timeline", acpxRecordId: input.acpxRecordId });
    return receipt;
  }

  async cancelTurn(input: AcpxCancelTurnInput): Promise<AcpxMutationReceipt<AcpxCancelTurnResult>> {
    const receipt = await runIdempotentMutation({
      operation: "cancel_turn",
      idempotencyKey: input.idempotencyKey,
      input,
      run: async () => {
        await this.requireExactRecord(input.acpxRecordId);
        const activeTurn = await getActiveSessionTimelineTurn(input.acpxRecordId);
        if (activeTurn?.turn_id !== input.turnId) {
          throw new AcpxTurnNotActiveError(input.turnId, activeTurn?.turn_id);
        }
        const cancelled = await cancelSessionPrompt({
          sessionId: input.acpxRecordId,
          turnId: input.turnId,
        });
        return {
          turnId: input.turnId,
          state: cancelled.cancelled ? "cancelling" : "unknown",
        } satisfies AcpxCancelTurnResult;
      },
    });
    this.emit({ type: "session", acpxRecordId: input.acpxRecordId });
    return receipt;
  }

  async closeSession(
    input: AcpxCloseSessionInput,
  ): Promise<AcpxMutationReceipt<AcpxSessionDetail>> {
    const receipt = await runIdempotentMutation({
      operation: "close_session",
      idempotencyKey: input.idempotencyKey,
      input,
      run: async () => {
        const record = await this.requireExactRecord(input.acpxRecordId);
        return await this.projectDetail(await closeOwnedSession(record.acpxRecordId));
      },
    });
    this.emit({ type: "sessions", acpxRecordId: input.acpxRecordId });
    return receipt;
  }

  private async pendingEntries(acpxRecordId: string): Promise<PendingRequest[]> {
    const stored = await listStoredPendingRequests(acpxRecordId);
    if (!(await readLiveQueueOwner(acpxRecordId))) {
      return stored.toSorted(pendingRequestSort);
    }
    try {
      const live =
        (await tryListRequestsOnRunningOwner({
          sessionId: acpxRecordId,
          responseTimeoutMs: LIVE_PENDING_LIST_TIMEOUT_MS,
        })) ?? [];
      return mergePending(stored, live);
    } catch {
      return stored.toSorted(pendingRequestSort);
    }
  }

  async listPendingRequests(input: { acpxRecordId: string }): Promise<AcpxPendingRequest[]> {
    await this.requireExactRecord(input.acpxRecordId);
    return (await this.pendingEntries(input.acpxRecordId)).map(projectPendingRequest);
  }

  private async assertAnswerableByLiveOwner(
    acpxRecordId: string,
    requestId: string,
  ): Promise<void> {
    const liveGeneration =
      (await readLiveQueueOwner(acpxRecordId))?.ownerGeneration ?? NO_LIVE_OWNER_GENERATION;
    const stored = await readPendingRequest(acpxRecordId, requestId);
    if (
      liveGeneration !== NO_LIVE_OWNER_GENERATION &&
      (stored === undefined || stored.ownerGeneration === liveGeneration)
    ) {
      return;
    }
    await sweepPendingRequests({ sessionId: acpxRecordId, ownerGeneration: liveGeneration });
    throw new PendingRequestOwnerGoneError(
      `Request ${requestId} can no longer be answered because its queue owner is not live`,
    );
  }

  async respondToPendingRequest(
    input: AcpxRespondPendingRequestInput,
  ): Promise<AcpxMutationReceipt<AcpxPendingRequest>> {
    const receipt = await runIdempotentMutation({
      operation: "respond_pending_request",
      idempotencyKey: input.idempotencyKey,
      input,
      run: async () => {
        await this.requireExactRecord(input.acpxRecordId);
        await this.assertAnswerableByLiveOwner(input.acpxRecordId, input.requestId);
        const answered = await tryRespondOnRunningOwner({
          sessionId: input.acpxRecordId,
          pendingRequestId: input.requestId,
          answer: input.answer,
          responseTimeoutMs:
            input.responseTimeoutMs ??
            this.options.pendingResponseTimeoutMs ??
            DEFAULT_PENDING_RESPONSE_TIMEOUT_MS,
        });
        if (!answered) {
          throw new PendingRequestOwnerGoneError(
            `Request ${input.requestId} can no longer be answered because its queue owner stopped`,
          );
        }
        return projectPendingRequest(answered);
      },
    });
    this.emit({ type: "pending", acpxRecordId: input.acpxRecordId });
    this.emit({ type: "session", acpxRecordId: input.acpxRecordId });
    return receipt;
  }

  async getTranscriptPage(input: {
    acpxRecordId: string;
    before?: string;
    limit?: number;
  }): Promise<AcpxTranscriptPage> {
    await this.requireExactRecord(input.acpxRecordId);
    return await listSessionTimelinePage(input.acpxRecordId, {
      before: input.before,
      limit: input.limit,
    });
  }

  async readTimeline(input: {
    acpxRecordId: string;
    before?: string;
    limit?: number;
  }): ReturnType<typeof listSessionTimelinePage> {
    return await this.getTranscriptPage(input);
  }

  subscribe(listener: (event: AcpxSessionInvalidation) => void): () => void {
    this.listeners.add(listener);
    this.ensurePolling();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
    };
  }

  private ensurePolling(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(
      () => void this.pollInvalidations(),
      Math.max(100, this.options.timelinePollMs ?? DEFAULT_TIMELINE_POLL_MS),
    );
    this.pollTimer.unref();
    void this.pollInvalidations();
  }

  // oxlint-disable-next-line eslint/complexity -- Polling compares four independent invalidation sources in one serialized pass.
  private async pollInvalidations(): Promise<void> {
    if (this.pollBusy || this.listeners.size === 0) {
      return;
    }
    this.pollBusy = true;
    try {
      const records = await listSessions();
      const liveIds = new Set(records.map((record) => record.acpxRecordId));
      for (const record of records) {
        const previous = this.observedRecords.get(record.acpxRecordId);
        const owner = await readQueueOwnerRecord(record.acpxRecordId);
        const next = recordFingerprint(record, owner);
        if (previous !== undefined && previous !== next) {
          this.emit({ type: "session", acpxRecordId: record.acpxRecordId });
          if (record.timeline?.last_seq !== undefined) {
            this.emit({ type: "timeline", acpxRecordId: record.acpxRecordId });
          }
        }
        if (this.pollingInitialized && previous === undefined) {
          this.emit({ type: "sessions", acpxRecordId: record.acpxRecordId });
        }
        this.observedRecords.set(record.acpxRecordId, next);

        const pending = await listStoredPendingRequests(record.acpxRecordId);
        const nextPending = pendingFingerprint(pending);
        const previousPending = this.observedPending.get(record.acpxRecordId);
        if (previousPending !== undefined && previousPending !== nextPending) {
          this.emit({ type: "pending", acpxRecordId: record.acpxRecordId });
        }
        this.observedPending.set(record.acpxRecordId, nextPending);
      }
      for (const observedId of this.observedRecords.keys()) {
        if (!liveIds.has(observedId)) {
          this.observedRecords.delete(observedId);
          this.observedPending.delete(observedId);
          this.emit({ type: "sessions" });
        }
      }
      this.pollingInitialized = true;
    } finally {
      this.pollBusy = false;
    }
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.listeners.clear();
  }
}

export function createAcpxSessionService(
  options: AcpxSessionsServiceOptions = {},
): AcpxSessionService {
  return new SessionService(options);
}

export const sessionsServiceTestInternals = {
  adapterOperationTimeout,
  configuredAgentArgv,
  exactRecord,
  mergePending,
  providerSessionProjection,
  registeredAgent,
};
