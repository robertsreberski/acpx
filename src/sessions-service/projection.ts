import type { AgentCapabilities } from "@agentclientprotocol/sdk";
import { AGENT_REGISTRY } from "../agent-registry.js";
import { inspectQueueOwnerHealth } from "../cli/queue/ipc-health.js";
import { getDesiredModelId } from "../session/mode-preference.js";
import { listPendingRequests, type PendingRequest } from "../session/pending-requests.js";
import {
  getActiveSessionTimelineTurn,
  getLatestSessionTimelineLifecycleEvent,
} from "../session/timeline.js";
import type { SessionRecord } from "../types.js";
import type {
  AcpxOwnerState,
  AcpxPendingRequest,
  AcpxRegisteredAgent,
  AcpxSessionDetail,
  AcpxSessionSummary,
  AcpxTurnState,
} from "./contract.js";

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
    resumeSession: capabilities.sessionCapabilities?.resume !== undefined,
    closeSession: capabilities.sessionCapabilities?.close !== undefined,
    listSessions: capabilities.sessionCapabilities?.list !== undefined,
  };
}

export async function projectSession(
  record: SessionRecord,
  detail: true,
  registry?: Record<string, string>,
): Promise<AcpxSessionDetail>;
export async function projectSession(
  record: SessionRecord,
  detail?: false,
  registry?: Record<string, string>,
): Promise<AcpxSessionSummary>;
// oxlint-disable-next-line eslint/complexity -- Projection combines deliberately independent session, owner, turn, queue, and pending axes.
export async function projectSession(
  record: SessionRecord,
  detail = false,
  registry: Record<string, string> = AGENT_REGISTRY,
): Promise<AcpxSessionSummary | AcpxSessionDetail> {
  const [health, pending, lifecycle, activeTurn] = await Promise.all([
    inspectQueueOwnerHealth(record.acpxRecordId),
    listPendingRequests(record.acpxRecordId),
    getLatestSessionTimelineLifecycleEvent(record.acpxRecordId),
    getActiveSessionTimelineTurn(record.acpxRecordId),
  ]);
  const waiting = pendingTurnState(pending);
  const lifecycleState = lifecycleTurnState(lifecycle);
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
    ownerState: ownerState(health),
    turnState: waiting ?? projectedLifecycleState,
    queue: { depth: health.queueDepth ?? 0 },
    createdAt: record.createdAt,
    updatedAt: record.lastUsedAt,
    model: record.acpx?.current_model_id ?? getDesiredModelId(record.acpx),
    mode: record.acpx?.current_mode_id ?? record.acpx?.desired_mode_id,
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
