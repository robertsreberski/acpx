import type { AgentCapabilities } from "@agentclientprotocol/sdk";
import { AGENT_REGISTRY } from "../agent-registry.js";
import { inspectQueueOwnerHealth } from "../cli/queue/ipc-health.js";
import { tryListPromptQueueOnRunningOwner } from "../cli/queue/ipc.js";
import {
  getDesiredModeId,
  getDesiredModelId,
  normalizeModeId,
} from "../session/mode-preference.js";
import { listPendingRequests, type PendingRequest } from "../session/pending-requests.js";
import {
  getActiveSessionTimelineTurn,
  getLatestSessionTimelineLifecycleEvent,
} from "../session/timeline.js";
import type { SessionRecord } from "../types.js";
import type {
  AcpxOwnerState,
  AcpxModeState,
  AcpxPendingRequest,
  AcpxRegisteredAgent,
  AcpxSessionDetail,
  AcpxSessionSummary,
  AcpxTurnState,
} from "./contract.js";

const WARM_OWNER_MODE_REMEDIATION =
  "A retained queue owner may still be using an older mode. Answer or cancel pending requests, " +
  "then close and reopen the session before relying on the saved mode.";

const MODE_CONFLICT_REMEDIATION =
  "The saved mode differs from the last adapter report. Answer or cancel pending requests, " +
  "then close and reopen the session before sending another prompt.";

const LIVE_QUEUE_SNAPSHOT_TIMEOUT_MS = 250;

type CapabilitySupport = "supported" | "unsupported" | "unknown";

function capabilitySupport(value: unknown): CapabilitySupport {
  return value === undefined ? "unknown" : value ? "supported" : "unsupported";
}

function recordedCapabilities(
  records: SessionRecord[],
  command: string,
): AgentCapabilities | undefined {
  return records.find((record) => record.agentCommand === command && record.agentCapabilities)
    ?.agentCapabilities;
}

function agentIdForRecord(record: SessionRecord, registry: Record<string, string>): string {
  const persistedAgentId = record.acpx?.agent_id;
  if (persistedAgentId && Object.hasOwn(registry, persistedAgentId)) {
    return persistedAgentId;
  }
  const matching = Object.entries(registry).find(([, command]) => command === record.agentCommand);
  return matching?.[0] ?? "unregistered";
}

export function projectRegisteredAgents(
  registry: Record<string, string>,
  records: SessionRecord[],
): AcpxRegisteredAgent[] {
  return Object.entries(registry)
    .map(([agentId, command]) => {
      const capabilities = recordedCapabilities(records, command);
      return {
        agentId,
        label: agentId,
        capabilities: {
          sessionList: capabilitySupport(capabilities?.sessionCapabilities?.list),
          sessionResume: capabilitySupport(capabilities?.sessionCapabilities?.resume),
          sessionLoad: capabilitySupport(capabilities?.loadSession),
        },
      } satisfies AcpxRegisteredAgent;
    })
    .toSorted((left, right) => left.agentId.localeCompare(right.agentId));
}

function ownerState(health: Awaited<ReturnType<typeof inspectQueueOwnerHealth>>): AcpxOwnerState {
  if (!health.hasLease) {
    return "absent";
  }
  if (!health.pidAlive) {
    return "dead";
  }
  if (health.healthy) {
    return "online";
  }
  // A suspended owner can still complete a kernel-level socket handshake. Without
  // a fresh heartbeat there is no bounded proof that it is merely starting.
  return "unreachable";
}

function pendingTurnState(entries: PendingRequest[]): AcpxTurnState | undefined {
  const pending = entries.filter((entry) => entry.state === "pending");
  if (pending.some((entry) => entry.kind === "elicitation")) {
    return "waiting_elicitation";
  }
  if (pending.some((entry) => entry.kind === "permission")) {
    return "waiting_permission";
  }
  return undefined;
}

// oxlint-disable-next-line eslint/complexity -- Every lifecycle variant maps explicitly to a public state.
function lifecycleTurnState(
  lifecycle: Awaited<ReturnType<typeof getLatestSessionTimelineLifecycleEvent>>,
): AcpxTurnState {
  const type = lifecycle?.payload.kind === "lifecycle" ? lifecycle.payload.event.type : undefined;
  switch (type) {
    case "turn_submitted":
      return "queued";
    case "turn_started":
      return "running";
    case "turn_completed":
      return "completed";
    case "turn_failed":
      return "failed";
    case "turn_cancelled":
      return "cancelled";
    case "turn_interrupted":
      return "interrupted";
    default:
      return "idle";
  }
}

function normalizedTitle(record: SessionRecord): string | undefined {
  return typeof record.title === "string" && record.title.trim() ? record.title : undefined;
}

function capabilityProjection(
  capabilities: AgentCapabilities | undefined,
): AcpxSessionDetail["agentCapabilities"] | undefined {
  if (!capabilities) {
    return undefined;
  }
  return {
    loadSession: capabilities.loadSession === true,
    resumeSession: capabilities.sessionCapabilities?.resume != null,
    closeSession: capabilities.sessionCapabilities?.close != null,
    listSessions: capabilities.sessionCapabilities?.list != null,
  };
}

function projectMode(
  record: SessionRecord,
  projectedOwnerState: AcpxOwnerState,
): Pick<
  AcpxSessionSummary,
  "mode" | "desiredMode" | "effectiveMode" | "modeState" | "modeRemediation"
> {
  const desiredMode = getDesiredModeId(record.acpx);
  const effectiveMode = normalizeModeId(record.acpx?.current_mode_id);
  let modeState: AcpxModeState;
  let modeRemediation: string | undefined;
  if (!desiredMode) {
    modeState = "unmanaged";
  } else if (effectiveMode && effectiveMode !== desiredMode) {
    modeState = "conflict";
    modeRemediation = MODE_CONFLICT_REMEDIATION;
  } else if (projectedOwnerState === "online" || projectedOwnerState === "unreachable") {
    // A stored current_mode_id can have come from the throwaway connection used
    // by an idle warm owner's control fallback. It therefore cannot prove what
    // the retained adapter session will use for the next prompt.
    modeState = "unverified";
    modeRemediation = WARM_OWNER_MODE_REMEDIATION;
  } else {
    modeState = "stored";
  }
  return {
    mode: effectiveMode ?? desiredMode,
    desiredMode,
    effectiveMode,
    modeState,
    modeRemediation,
  };
}

export async function projectSession(
  record: SessionRecord,
  detail: true,
  registry?: Record<string, string>,
  pendingEntries?: PendingRequest[],
): Promise<AcpxSessionDetail>;
export async function projectSession(
  record: SessionRecord,
  detail?: false,
  registry?: Record<string, string>,
  pendingEntries?: PendingRequest[],
): Promise<AcpxSessionSummary>;
// oxlint-disable-next-line eslint/complexity -- Projection combines deliberately independent session, owner, turn, queue, and pending axes.
export async function projectSession(
  record: SessionRecord,
  detail = false,
  registry: Record<string, string> = AGENT_REGISTRY,
  pendingEntries?: PendingRequest[],
): Promise<AcpxSessionSummary | AcpxSessionDetail> {
  const health = await inspectQueueOwnerHealth(record.acpxRecordId);
  const queueSnapshot = health.healthy
    ? tryListPromptQueueOnRunningOwner({
        sessionId: record.acpxRecordId,
        responseTimeoutMs: LIVE_QUEUE_SNAPSHOT_TIMEOUT_MS,
      }).catch(() => undefined)
    : Promise.resolve(undefined);
  const [pending, lifecycle, activeTurn, authoritativeQueue] = await Promise.all([
    pendingEntries ?? listPendingRequests(record.acpxRecordId),
    getLatestSessionTimelineLifecycleEvent(record.acpxRecordId),
    getActiveSessionTimelineTurn(record.acpxRecordId),
    queueSnapshot,
  ]);
  const waiting = pendingTurnState(pending);
  const lifecycleState = lifecycleTurnState(lifecycle);
  const projectedOwnerState = ownerState(health);
  const queuedTurns =
    authoritativeQueue !== undefined &&
    authoritativeQueue.ownerGeneration === health.ownerGeneration
      ? authoritativeQueue.prompts
      : [];
  // The lease depth remains useful when an owner is old or unreachable. Exact
  // cancellation targets never come from it (or from timeline guesses); only
  // a current generation's read-only FIFO snapshot can expose those controls.
  const queueDepth = health.queueDepth ?? authoritativeQueue?.prompts.length ?? 0;
  const projectedLifecycleState =
    activeTurn && !health.healthy ? "unknown" : activeTurn ? "running" : lifecycleState;
  const summary: AcpxSessionSummary = {
    acpxRecordId: record.acpxRecordId,
    acpSessionId: record.acpSessionId,
    agentSessionId: record.agentSessionId,
    agentId: agentIdForRecord(record, registry),
    name: record.name,
    cwd: record.cwd,
    title: normalizedTitle(record),
    sessionState: record.closed === true ? "closed" : "open",
    ownerState: projectedOwnerState,
    turnState: waiting ?? projectedLifecycleState,
    queue: { depth: queueDepth, turns: queuedTurns },
    createdAt: record.createdAt,
    updatedAt: record.lastUsedAt,
    model: record.acpx?.current_model_id ?? getDesiredModelId(record.acpx),
    ...projectMode(record, projectedOwnerState),
    activeTurnId: health.healthy ? activeTurn?.turn_id : undefined,
    pendingCount: pending.filter((entry) => entry.state === "pending").length,
  };
  if (!detail) {
    return summary;
  }
  return {
    ...summary,
    agentCapabilities: capabilityProjection(record.agentCapabilities),
  };
}

export function projectPendingRequest(entry: PendingRequest): AcpxPendingRequest {
  if (entry.kind === "elicitation") {
    return {
      requestId: entry.requestId,
      acpxRecordId: entry.sessionId,
      kind: entry.kind,
      state: entry.state,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      title: entry.elicitation.message,
      detail: entry.elicitation.message,
      requestedSchema: entry.elicitation.requestedSchema,
      resolution: entry.resolution
        ? {
            source: entry.resolution.source,
            action: entry.resolution.action,
            optionId: entry.resolution.optionId,
            resolvedAt: entry.resolution.answeredAt,
          }
        : undefined,
    };
  }
  return {
    requestId: entry.requestId,
    acpxRecordId: entry.sessionId,
    kind: entry.kind,
    state: entry.state,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    title: entry.toolCall.title,
    detail: entry.toolCall.kind,
    options: entry.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
    resolution: entry.resolution
      ? {
          source: entry.resolution.source,
          action: entry.resolution.action,
          optionId: entry.resolution.optionId,
          resolvedAt: entry.resolution.answeredAt,
        }
      : undefined,
  };
}
