import { randomUUID } from "node:crypto";
import path from "node:path";
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
import {
  isQueueOwnerHeartbeatStale,
  queueOwnerWritesTimeline,
  readLiveQueueOwner,
  readQueueOwnerRecord,
} from "../cli/queue/lease-store.js";
import { queueOwnerSpawnArgsForModule } from "../cli/session/queue-owner-process.js";
import { sendSession } from "../cli/session/queue-owner-runtime.js";
import {
  cancelSessionPrompt,
  closeSessionWithResult as closeOwnedSessionWithResult,
  setSessionMode,
} from "../cli/session/session-control.js";
import { createSessionWithClient, listAgentSessions } from "../cli/session/session-management.js";
import { PendingRequestOwnerGoneError, SessionNotFoundError } from "../errors.js";
import { isProcessAlive } from "../process-liveness.js";
import { promptToDisplayText, textPrompt } from "../prompt-content.js";
import { applyLifecycleSnapshotToRecord } from "../runtime/engine/lifecycle.js";
import { normalizeModeId, setDesiredModeId } from "../session/mode-preference.js";
import {
  listPendingRequests as listStoredPendingRequests,
  readPendingRequest,
  sweepPendingRequests,
  type PendingRequest,
} from "../session/pending-requests.js";
import {
  listOpenSessionsForSubscription,
  listSessions,
  writeSessionRecord,
} from "../session/persistence.js";
import {
  appendSessionTimelineLifecycleEvent,
  getActiveSessionTimelineTurn,
  listSessionTimelinePage,
  SessionTimelineWriter,
} from "../session/timeline.js";
import type { PermissionPolicy, SessionRecord } from "../types.js";
import type {
  AcpxAdoptSessionInput,
  AcpxCancelTurnInput,
  AcpxCancelTurnResult,
  AcpxCloseSessionInput,
  AcpxCloseSessionResult,
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
const SUBSCRIPTION_POLL_CONCURRENCY = 8;
const SESSION_PROJECTION_CONCURRENCY = 8;

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
  phase: "allocated" | "created" | "configured";
};

function parseStartSessionCheckpoint(value: unknown): StartSessionCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid persisted session-start recovery checkpoint");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.recordId !== "string" ||
    (record.phase !== "allocated" && record.phase !== "created" && record.phase !== "configured")
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

export class AcpxSessionStartInDoubtError extends Error {
  readonly code = "SESSION_START_RESULT_UNKNOWN";

  constructor(recordId: string) {
    super(
      `Session start for local record ${recordId} may have reached the provider, but no durable ` +
        "session record exists; refusing to repeat the provider mutation",
    );
    this.name = "AcpxSessionStartInDoubtError";
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

function effectiveSessionMode(input: AcpxCreateSessionInput, agentId: string): string | undefined {
  return normalizeModeId(input.mode) ?? defaultMode(agentId);
}

function sessionStartRecoveryScope(
  input: AcpxCreateSessionInput,
  agent: Pick<ResolvedAgent, "agentId">,
  providerSessionId?: string,
): Record<string, unknown> {
  return {
    agentId: agent.agentId,
    cwd: path.resolve(input.cwd),
    name: input.name,
    mode: effectiveSessionMode(input, agent.agentId),
    model: input.model,
    permissionMode: input.permissionMode,
    permissionPolicy: input.permissionPolicy,
    providerSessionId,
  };
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

async function mapConcurrentBounded<T, TResult>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<TResult>,
): Promise<TResult[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }
  let next = 0;
  const results: TResult[] = [];
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) {
        return;
      }
      results[index] = await run(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function subscriptionWorkspaceRoots(
  options: AcpxSessionsServiceOptions,
): readonly string[] | undefined {
  if (options.subscriptionWorkspaceRoots !== undefined) {
    return options.subscriptionWorkspaceRoots;
  }
  return options.cwd ? [options.cwd] : undefined;
}

async function listSubscriptionRecords(
  options: AcpxSessionsServiceOptions,
): Promise<SessionRecord[]> {
  const roots = subscriptionWorkspaceRoots(options);
  // An embedding server that resolved no safe roots must observe nothing.
  // Only an omitted scope is allowed to retain the legacy unscoped behavior.
  return roots?.length === 0 ? [] : await listOpenSessionsForSubscription(roots);
}

function ownerFingerprint(owner: Awaited<ReturnType<typeof readQueueOwnerRecord>>): string {
  if (!owner) {
    return "absent";
  }
  // The timestamp itself advances during healthy idle operation and carries no
  // projected state. Hash only the semantic threshold it crosses so normal
  // heartbeats do not fan out as session + timeline invalidations, while a
  // stopped process or stale owner still refreshes browser-visible health.
  return [
    owner.ownerGeneration,
    owner.queueDepth,
    isProcessAlive(owner.pid) ? "alive" : "dead",
    isQueueOwnerHeartbeatStale(owner) ? "stale" : "fresh",
  ].join(":");
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
    ownerFingerprint(owner),
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

  private async projectionRegistry(record: SessionRecord): Promise<Record<string, string>> {
    try {
      return await this.registry(record.cwd);
    } catch {
      // Read projections must remain available when one retained workspace has
      // since acquired a malformed config. Preserve the durable agent identity
      // without weakening config validation on mutations for that workspace.
      const persistedAgentId = record.acpx?.agent_id;
      return mergeAgentRegistry(
        persistedAgentId ? { [persistedAgentId]: record.agentCommand } : undefined,
      );
    }
  }

  private adapterTimeout(config: ResolvedAcpxConfig): number {
    return adapterOperationTimeout(this.options, config);
  }

  private async projectDetail(record: SessionRecord): Promise<AcpxSessionDetail> {
    const [registry, pending] = await Promise.all([
      this.projectionRegistry(record),
      this.pendingEntries(record.acpxRecordId),
    ]);
    return await projectSession(record, true, registry, pending);
  }

  private async projectSummary(record: SessionRecord): Promise<AcpxSessionSummary> {
    const [registry, pending] = await Promise.all([
      this.projectionRegistry(record),
      this.pendingEntries(record.acpxRecordId),
    ]);
    return await projectSession(record, false, registry, pending);
  }

  // oxlint-disable-next-line eslint/complexity -- Recovery must validate each durable identity axis before reconnecting.
  private assertStartedSessionIdentity(
    record: SessionRecord,
    agent: ResolvedAgent,
    providerSessionId?: string,
  ): void {
    const sameAgent =
      record.acpx?.agent_id === agent.agentId ||
      (record.acpx?.agent_id === undefined && record.agentCommand === agent.agentCommand);
    if (
      !sameAgent ||
      record.closed === true ||
      (providerSessionId !== undefined && record.acpSessionId !== providerSessionId)
    ) {
      throw new Error(
        `Persisted session-start checkpoint does not match the requested session ` +
          `(record agent ${JSON.stringify(record.acpx?.agent_id)}, requested agent ${JSON.stringify(agent.agentId)}, ` +
          `record command ${JSON.stringify(record.agentCommand)}, requested command ${JSON.stringify(agent.agentCommand)}, ` +
          `record provider ${JSON.stringify(record.acpSessionId)}, requested provider ${JSON.stringify(providerSessionId)})`,
      );
    }
  }

  private async ensureStartedSessionMode(
    input: AcpxCreateSessionInput,
    agent: ResolvedAgent,
    record: SessionRecord,
  ): Promise<SessionRecord> {
    const mode = effectiveSessionMode(input, agent.agentId);
    if (!mode || record.acpx?.desired_mode_id === mode) {
      return record;
    }
    const applied = await setSessionMode({
      sessionId: record.acpxRecordId,
      modeId: mode,
      mcpServers: agent.config.mcpServers,
      nonInteractivePermissions:
        this.options.nonInteractivePermissions ?? agent.config.nonInteractivePermissions,
      authCredentials: { ...agent.config.auth, ...this.options.authCredentials },
      authPolicy: this.options.authPolicy ?? agent.config.authPolicy,
      timeoutMs: this.adapterTimeout(agent.config),
    });
    return applied.record;
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

  async listAgents(input: { cwd: string }): Promise<AcpxRegisteredAgent[]> {
    const [config, records] = await Promise.all([this.config(input.cwd), listSessions()]);
    return projectRegisteredAgents(mergeAgentRegistry(customCommands(config)), records);
  }

  async listSessions(): Promise<AcpxSessionSummary[]> {
    const records = await listSessions();
    // Every live-owner read is bounded by LIVE_PENDING_LIST_TIMEOUT_MS. Keep
    // projections concurrent, but cap the owner/socket pressure from a large
    // retained inventory rather than opening one connection per session.
    return await mapConcurrentBounded(
      records,
      SESSION_PROJECTION_CONCURRENCY,
      async (record) => await this.projectSummary(record),
    );
  }

  async getSession(input: { acpxRecordId: string }): Promise<AcpxSessionDetail | undefined> {
    const record = exactRecord(await listSessions(), input.acpxRecordId);
    return record ? await this.projectDetail(record) : undefined;
  }

  async listProviderSessions(input: {
    agentId: string;
    cwd: string;
    cursor?: string;
  }): Promise<AcpxProviderSessionPage> {
    const cwd = input.cwd;
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
        if (path.resolve(existing.cwd) !== path.resolve(input.cwd)) {
          throw new AcpxSessionAdoptionError(
            agent.agentId,
            providerSessionId,
            new Error(
              `provider session is already adopted in workspace ${JSON.stringify(path.resolve(existing.cwd))}`,
            ),
          );
        }
        if (existing.acpx?.agent_id === undefined) {
          existing.acpx = { ...existing.acpx, agent_id: agent.agentId };
          await writeSessionRecord(existing);
        }
        this.assertStartedSessionIdentity(existing, agent, providerSessionId);
        await checkpoint?.({ recordId: existing.acpxRecordId, phase: "created" });
        const configured = await this.ensureStartedSessionMode(input, agent, existing);
        await checkpoint?.({ recordId: existing.acpxRecordId, phase: "configured" });
        return await this.projectDetail(configured);
      }
      const unverified = candidates.find((record) => record.acpx?.agent_id === undefined);
      if (unverified) {
        throw new AcpxSessionAdoptionError(
          agent.agentId,
          providerSessionId,
          new Error("provider session is already adopted by an unverified agent command"),
        );
      }
    }

    const recordId = randomUUID();
    let created: Awaited<ReturnType<typeof createSessionWithClient>>;
    try {
      created = await createSessionWithClient({
        acpxRecordId: recordId,
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
        onProviderMutationDispatch: async () => {
          // Persist the ambiguity boundary immediately before the provider RPC.
          // Spawn, initialization, and capability failures occur before this
          // checkpoint and therefore do not poison fresh-key recovery scopes.
          await checkpoint?.({ recordId, phase: "allocated" });
        },
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
      const mode = effectiveSessionMode(input, agent.agentId);
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
    const [agent, records] = await Promise.all([
      this.resolveAgent(input.agentId, input.cwd),
      listSessions(),
    ]);
    const record = exactRecord(records, checkpoint.recordId);
    if (!record) {
      if (checkpoint.phase === "allocated") {
        throw new AcpxSessionStartInDoubtError(checkpoint.recordId);
      }
      throw new SessionNotFoundError(checkpoint.recordId);
    }
    this.assertStartedSessionIdentity(record, agent, providerSessionId);
    if (record.acpx?.agent_id === undefined) {
      record.acpx = { ...record.acpx, agent_id: agent.agentId };
      await writeSessionRecord(record);
    }
    if (checkpoint.phase !== "configured") {
      await this.ensureStartedSessionMode(input, agent, record);
    }
    return await this.projectDetail(await this.requireExactRecord(checkpoint.recordId));
  }

  async createSession(
    input: AcpxCreateSessionInput,
  ): Promise<AcpxMutationReceipt<AcpxSessionDetail>> {
    const agent = await this.resolveAgent(input.agentId, input.cwd);
    const receipt = await runIdempotentMutation({
      operation: "create_session",
      idempotencyKey: input.idempotencyKey,
      input,
      recoveryScope: sessionStartRecoveryScope(input, agent),
      recover: async (checkpoint) => await this.recoverStartedSession(input, checkpoint),
      run: async (checkpoint) => await this.startSession(input, undefined, checkpoint),
    });
    this.emit({ type: "sessions", acpxRecordId: receipt.result.acpxRecordId });
    return receipt;
  }

  async adoptSession(
    input: AcpxAdoptSessionInput,
  ): Promise<AcpxMutationReceipt<AcpxSessionDetail>> {
    const agent = await this.resolveAgent(input.agentId, input.cwd);
    const receipt = await runIdempotentMutation({
      operation: "adopt_session",
      idempotencyKey: input.idempotencyKey,
      input,
      recoveryScope: sessionStartRecoveryScope(input, agent, input.providerSessionId),
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
    const mutation = {
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
        const prompt = typeof input.prompt === "string" ? textPrompt(input.prompt) : input.prompt;
        await appendSessionTimelineLifecycleEvent(
          record,
          { type: "turn_submitted", prompt_text: promptToDisplayText(prompt) },
          { turnId, requestId: turnId },
        );
        let result: Awaited<ReturnType<typeof sendSession>>;
        try {
          result = await sendSession({
            sessionId: record.acpxRecordId,
            turnId,
            prompt,
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
    } as const;
    let receipt: AcpxMutationReceipt<AcpxEnqueuePromptResult>;
    try {
      receipt = await runIdempotentMutation(mutation);
    } catch (error) {
      if (!isQueueAdmissionOutcomeUnknown(error)) {
        throw error;
      }
      // Queue admission crossed the write boundary, so surfacing the transport
      // error would invite a caller to retry with a fresh key and duplicate the
      // prompt. Replaying the exact key reads the durable recovery result and
      // never submits again; callers receive the original turn id as unknown.
      receipt = await runIdempotentMutation(mutation);
    }
    this.emit({ type: "session", acpxRecordId: input.acpxRecordId });
    this.emit({ type: "timeline", acpxRecordId: input.acpxRecordId });
    return receipt;
  }

  async cancelTurn(input: AcpxCancelTurnInput): Promise<AcpxMutationReceipt<AcpxCancelTurnResult>> {
    const receipt = await runIdempotentMutation<AcpxCancelTurnResult>({
      operation: "cancel_turn",
      idempotencyKey: input.idempotencyKey,
      input,
      recoveryResult: {
        turnId: input.turnId,
        state: "unknown",
      } satisfies AcpxCancelTurnResult,
      outcomeUnknown: isQueueAdmissionOutcomeUnknown,
      run: async () => {
        await this.requireExactRecord(input.acpxRecordId);
        const cancelled = await cancelSessionPrompt({
          sessionId: input.acpxRecordId,
          turnId: input.turnId,
        });
        if (cancelled.outcome === "queued") {
          return { turnId: input.turnId, state: "cancelled" } satisfies AcpxCancelTurnResult;
        }
        if (cancelled.outcome === "active") {
          return { turnId: input.turnId, state: "cancelling" } satisfies AcpxCancelTurnResult;
        }
        const activeTurn = await getActiveSessionTimelineTurn(input.acpxRecordId);
        throw new AcpxTurnNotActiveError(input.turnId, activeTurn?.turn_id);
      },
    });
    this.emit({ type: "session", acpxRecordId: input.acpxRecordId });
    this.emit({ type: "timeline", acpxRecordId: input.acpxRecordId });
    return receipt;
  }

  async closeSession(
    input: AcpxCloseSessionInput,
  ): Promise<AcpxMutationReceipt<AcpxCloseSessionResult>> {
    const receipt = await runIdempotentMutation<AcpxCloseSessionResult>({
      operation: "close_session",
      idempotencyKey: input.idempotencyKey,
      input,
      run: async () => {
        const record = await this.requireExactRecord(input.acpxRecordId);
        const closed = await closeOwnedSessionWithResult(record.acpxRecordId);
        return {
          session: await this.projectDetail(closed.record),
          localClose: "closed",
          providerClose: closed.providerClose,
        };
      },
    });
    this.emit({ type: "sessions", acpxRecordId: input.acpxRecordId });
    return receipt;
  }

  /**
   * Merge durable history with the authoritative waiter set of a live owner.
   * If that owner cannot answer within the bounded read window, durable state
   * remains the safe lower bound: inspecting a slow owner must never retire it
   * or rewrite requests it may still be able to answer.
   */
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

  // oxlint-disable-next-line eslint/complexity -- Migration admission distinguishes initial, incomplete, and legacy-owner states.
  async getTranscriptPage(input: {
    acpxRecordId: string;
    before?: string;
    limit?: number;
  }): Promise<AcpxTranscriptPage> {
    const record = await this.requireExactRecord(input.acpxRecordId);
    // Retained pre-ledger traffic used to appear only after the next prompt,
    // because prompt execution was the first path that opened a timeline
    // writer. Admission and owner capability are resolved inside the timeline
    // lock so an old-to-modern handoff cannot turn a stale legacy decision into
    // a duplicate import of the modern writer's compatibility copy.
    const legacyImportPending = await SessionTimelineWriter.refreshLegacyCompatibility(
      record.acpxRecordId,
      {
        legacyOwnerCanAppend: async () => {
          const liveOwner = await readLiveQueueOwner(record.acpxRecordId);
          return liveOwner !== undefined && !queueOwnerWritesTimeline(liveOwner);
        },
      },
    );
    const page = await listSessionTimelinePage(input.acpxRecordId, {
      before: input.before,
      limit: input.limit,
    });
    return legacyImportPending ? { ...page, legacyImportPending: true } : page;
  }

  async readTimeline(input: {
    acpxRecordId: string;
    before?: string;
    limit?: number;
  }): Promise<AcpxTranscriptPage> {
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
      () => this.pollInvalidationsInBackground(),
      Math.max(100, this.options.timelinePollMs ?? DEFAULT_TIMELINE_POLL_MS),
    );
    this.pollTimer.unref();
    this.pollInvalidationsInBackground();
  }

  private pollInvalidationsInBackground(): void {
    void this.pollInvalidations().catch((error: unknown) => {
      if (this.options.onBackgroundError) {
        void Promise.resolve()
          .then(async () => await this.options.onBackgroundError?.(error))
          .catch((callbackError: unknown) => {
            console.warn("[acpx sessions] background error callback failed", callbackError);
          });
        return;
      }
      console.warn("[acpx sessions] invalidation polling failed", error);
    });
  }

  private async pollRecordState(record: SessionRecord): Promise<void> {
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
  }

  private async pollPendingState(record: SessionRecord): Promise<void> {
    const pending = await listStoredPendingRequests(record.acpxRecordId);
    const nextPending = pendingFingerprint(pending);
    const previousPending = this.observedPending.get(record.acpxRecordId);
    if (
      (previousPending !== undefined && previousPending !== nextPending) ||
      (previousPending === undefined && pending.length > 0)
    ) {
      this.emit({ type: "pending", acpxRecordId: record.acpxRecordId });
    }
    this.observedPending.set(record.acpxRecordId, nextPending);
  }

  private async pollRecord(record: SessionRecord): Promise<void> {
    await this.pollRecordState(record);
    await this.pollPendingState(record);
  }

  private async pollInvalidations(): Promise<void> {
    if (this.pollBusy || this.listeners.size === 0) {
      return;
    }
    this.pollBusy = true;
    try {
      const records = await listSubscriptionRecords(this.options);
      const liveIds = new Set(records.map((record) => record.acpxRecordId));
      await mapConcurrentBounded(
        records,
        SUBSCRIPTION_POLL_CONCURRENCY,
        async (record) => await this.pollRecord(record),
      );
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
  listSubscriptionRecords,
  mapConcurrentBounded,
  mergePending,
  ownerFingerprint,
  providerSessionProjection,
  recordFingerprint,
  registeredAgent,
  sessionStartRecoveryScope,
};
