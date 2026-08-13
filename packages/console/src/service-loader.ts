import { ConsoleInputError } from "./config.js";
import type {
  AcpxConsoleSessionService,
  ConsoleAgent,
  ConsoleCloseSessionResult,
  ConsoleSession,
  PendingInteraction,
  ProviderSession,
  ServiceInvalidation,
  TimelinePage,
  TurnState,
} from "./contracts.js";

type PendingAnswer =
  | { type: "select"; option_id: string }
  | { type: "accept"; content: Record<string, string | number | boolean | string[]> }
  | { type: "decline" }
  | { type: "cancel" };

type CoreReceipt<T> = { result: T; replayed: boolean; idempotencyKey: string; operation: string };
type CoreAgent = {
  agentId: string;
  label: string;
  capabilities: { sessionList: "supported" | "unsupported" | "unknown" };
};
type CoreSession = ConsoleSession & { acpSessionId?: string; title?: string };
type CoreProviderSession = {
  providerSessionId: string;
  title?: string;
  cwd?: string;
  updatedAt?: string;
};
type CorePending = Omit<PendingInteraction, "schema"> & {
  requestedSchema?: Record<string, unknown>;
};
type CoreCloseSessionResult = ConsoleCloseSessionResult;
type CorePermissionPolicy = {
  autoApprove?: string[];
  autoDeny?: string[];
  escalate?: string[];
  defer?: string[];
  defaultAction?: "approve" | "deny" | "escalate" | "defer";
};
interface CoreSessionsService {
  listAgents(input: { cwd: string }): Promise<CoreAgent[]>;
  listSessions(): Promise<CoreSession[]>;
  getSession(input: { acpxRecordId: string }): Promise<CoreSession | undefined>;
  listProviderSessions(input: {
    agentId: string;
    cwd: string;
    cursor?: string;
  }): Promise<{ sessions: CoreProviderSession[]; nextCursor?: string }>;
  createSession(input: {
    agentId: string;
    cwd: string;
    name?: string;
    mode?: string;
    model?: string;
    permissionPolicy?: CorePermissionPolicy;
    idempotencyKey: string;
  }): Promise<CoreReceipt<CoreSession>>;
  adoptSession(input: {
    agentId: string;
    providerSessionId: string;
    cwd: string;
    name?: string;
    mode?: string;
    permissionPolicy?: CorePermissionPolicy;
    idempotencyKey: string;
  }): Promise<CoreReceipt<CoreSession>>;
  enqueuePrompt(input: {
    acpxRecordId: string;
    prompt: string;
    permissionPolicy?: CorePermissionPolicy;
    idempotencyKey: string;
  }): Promise<CoreReceipt<{ turnId: string; admission: "started" | "queued" | "unknown" }>>;
  cancelTurn(input: {
    acpxRecordId: string;
    turnId: string;
    idempotencyKey: string;
  }): Promise<CoreReceipt<{ turnId: string; state: TurnState }>>;
  closeSession(input: {
    acpxRecordId: string;
    idempotencyKey: string;
  }): Promise<CoreReceipt<CoreCloseSessionResult>>;
  listPendingRequests(input: { acpxRecordId: string }): Promise<CorePending[]>;
  respondToPendingRequest(input: {
    acpxRecordId: string;
    requestId: string;
    answer: PendingAnswer;
    idempotencyKey: string;
  }): Promise<CoreReceipt<CorePending>>;
  getTranscriptPage(input: {
    acpxRecordId: string;
    before?: string;
    limit?: number;
  }): Promise<TimelinePage>;
  subscribe(listener: (event: ServiceInvalidation) => void): () => void;
  dispose(): void;
}

interface SessionsModule {
  createAcpxSessionService(options?: unknown): CoreSessionsService;
}

const DEFER_RISKY_POLICY: CorePermissionPolicy = {
  autoApprove: ["read", "search"],
  defer: ["edit", "execute", "switch_mode"],
  defaultAction: "defer",
};

function permissionPolicy(value: unknown): CorePermissionPolicy {
  if (value === undefined || value === "defer-risky") {
    return DEFER_RISKY_POLICY;
  }
  throw new Error("ACPX Console only accepts the defer-risky permission policy");
}

function defaultMode(agentId: string, supplied: string | undefined): string | undefined {
  const requested = supplied?.trim();
  if (requested) {
    return requested;
  }
  if (agentId === "codex") {
    return "read-only";
  }
  if (agentId === "claude") {
    return "default";
  }
  throw new ConsoleInputError(`A mode is required for agent ${agentId}`);
}

function pendingAnswer(value: unknown): PendingAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("type" in value)) {
    throw new ConsoleInputError("pending response must be a tagged answer object");
  }
  const answer = value as Record<string, unknown>;
  if (answer.type === "select" && typeof answer.option_id === "string" && answer.option_id) {
    return { type: "select", option_id: answer.option_id };
  }
  if (answer.type === "decline" || answer.type === "cancel") {
    return { type: answer.type };
  }
  if (
    answer.type === "accept" &&
    answer.content &&
    typeof answer.content === "object" &&
    !Array.isArray(answer.content)
  ) {
    for (const field of Object.values(answer.content as Record<string, unknown>)) {
      const scalar =
        typeof field === "string" || typeof field === "number" || typeof field === "boolean";
      const strings = Array.isArray(field) && field.every((item) => typeof item === "string");
      if (!scalar && !strings) {
        throw new ConsoleInputError("elicitation content values must be scalar or string arrays");
      }
    }
    return {
      type: "accept",
      content: answer.content as Record<string, string | number | boolean | string[]>,
    };
  }
  throw new ConsoleInputError("pending response has an unsupported answer shape");
}

function projectAgent(agent: CoreAgent): ConsoleAgent {
  return {
    agentId: agent.agentId,
    label: agent.label,
    supportsSessionList:
      agent.capabilities.sessionList === "unknown"
        ? undefined
        : agent.capabilities.sessionList === "supported",
  };
}

const TIMELINE_WRITE_WARNING =
  "Authoritative timeline persistence failed; recent history may be incomplete.";

function projectTimeline(page: TimelinePage): TimelinePage {
  return {
    ...page,
    writeError: page.writeError ? TIMELINE_WRITE_WARNING : undefined,
  };
}

function projectProviderSession(session: CoreProviderSession): ProviderSession {
  return {
    providerSessionId: session.providerSessionId,
    title: session.title,
    cwd: session.cwd,
    updatedAt: session.updatedAt,
  };
}

function projectPending(request: CorePending): PendingInteraction {
  return { ...request, schema: request.requestedSchema };
}

export function adaptAcpxSessionService(core: CoreSessionsService): AcpxConsoleSessionService {
  return {
    async listAgents(input) {
      return (await core.listAgents(input)).map(projectAgent);
    },
    listSessions: () => core.listSessions(),
    getSession: (input) => core.getSession(input),
    async listProviderSessions(input) {
      const page = await core.listProviderSessions(input);
      return { sessions: page.sessions.map(projectProviderSession), nextCursor: page.nextCursor };
    },
    async createSession(input) {
      return (
        await core.createSession({
          agentId: input.agentId,
          cwd: input.cwd,
          name: input.name,
          mode: defaultMode(input.agentId, input.mode),
          model: input.model,
          permissionPolicy: permissionPolicy(input.policy),
          idempotencyKey: input.idempotencyKey,
        })
      ).result;
    },
    async adoptSession(input) {
      return (
        await core.adoptSession({
          ...input,
          mode: defaultMode(input.agentId, input.mode),
          permissionPolicy: permissionPolicy(undefined),
        })
      ).result;
    },
    async enqueuePrompt(input) {
      return (
        await core.enqueuePrompt({
          acpxRecordId: input.acpxRecordId,
          prompt: input.text,
          permissionPolicy: permissionPolicy(undefined),
          idempotencyKey: input.idempotencyKey,
        })
      ).result;
    },
    async cancelTurn(input) {
      return (await core.cancelTurn(input)).result;
    },
    async closeSession(input) {
      return (await core.closeSession(input)).result;
    },
    async listPendingRequests(input) {
      return (await core.listPendingRequests(input)).map(projectPending);
    },
    async respondToPendingRequest(input) {
      return (
        await core.respondToPendingRequest({
          acpxRecordId: input.acpxRecordId,
          requestId: input.requestId,
          answer: pendingAnswer(input.response),
          idempotencyKey: input.idempotencyKey,
        })
      ).result;
    },
    async getTranscriptPage(input) {
      return projectTimeline(await core.getTranscriptPage(input));
    },
    subscribe: (listener) => core.subscribe(listener),
    dispose: () => core.dispose(),
  };
}

function sessionsModule(value: unknown): SessionsModule {
  if (
    typeof value !== "object" ||
    value === null ||
    !("createAcpxSessionService" in value) ||
    typeof value.createAcpxSessionService !== "function"
  ) {
    throw new Error("Installed acpx does not export createAcpxSessionService from acpx/sessions");
  }
  return value as SessionsModule;
}

export async function loadAcpxSessionService(): Promise<AcpxConsoleSessionService> {
  const moduleName = "acpx/sessions";
  const module = sessionsModule(await import(moduleName));
  return adaptAcpxSessionService(module.createAcpxSessionService());
}
