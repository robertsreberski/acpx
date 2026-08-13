import type {
  AcpxConsoleSessionService,
  ConsoleAgent,
  ConsoleSession,
  PendingInteraction,
  ServiceInvalidation,
  TimelinePage,
} from "../src/contracts.js";

export const session: ConsoleSession = {
  acpxRecordId: "record-1",
  agentId: "codex",
  name: "demo",
  cwd: "/tmp/demo",
  sessionState: "open",
  ownerState: "online",
  turnState: "idle",
  queue: { depth: 0, turns: [] },
  updatedAt: "2026-08-12T00:00:00.000Z",
};

export class MockSessionService implements AcpxConsoleSessionService {
  readonly agents: ConsoleAgent[] = [{ agentId: "codex", label: "Codex" }];
  readonly sessions: ConsoleSession[];
  readonly calls: Array<{ method: string; input: unknown }> = [];
  private listener?: (event: ServiceInvalidation) => void;

  constructor(sessionCwd = session.cwd) {
    this.sessions = [{ ...session, cwd: sessionCwd }];
  }

  async listAgents(_input: { cwd: string }) {
    return this.agents;
  }
  async listSessions() {
    return this.sessions;
  }
  async getSession(input: { acpxRecordId: string }) {
    return this.sessions.find((candidate) => candidate.acpxRecordId === input.acpxRecordId);
  }
  async listProviderSessions(input: {
    agentId: string;
    cwd: string;
    cursor?: string;
  }): ReturnType<AcpxConsoleSessionService["listProviderSessions"]> {
    this.calls.push({ method: "listProviderSessions", input });
    return {
      sessions: [{ providerSessionId: "provider-1", title: "Existing", cwd: input.cwd }],
    };
  }
  async createSession(input: Parameters<AcpxConsoleSessionService["createSession"]>[0]) {
    this.calls.push({ method: "createSession", input });
    return { ...session, cwd: input.cwd, agentId: input.agentId };
  }
  async adoptSession(input: Parameters<AcpxConsoleSessionService["adoptSession"]>[0]) {
    this.calls.push({ method: "adoptSession", input });
    return { ...this.sessions[0], cwd: input.cwd, agentId: input.agentId };
  }
  async enqueuePrompt(
    input: Parameters<AcpxConsoleSessionService["enqueuePrompt"]>[0],
  ): ReturnType<AcpxConsoleSessionService["enqueuePrompt"]> {
    this.calls.push({ method: "enqueuePrompt", input });
    return { turnId: "turn-1", admission: "started" as const };
  }
  async cancelTurn(input: Parameters<AcpxConsoleSessionService["cancelTurn"]>[0]) {
    this.calls.push({ method: "cancelTurn", input });
    return { turnId: input.turnId, state: "cancelling" as const };
  }
  async closeSession(
    input: Parameters<AcpxConsoleSessionService["closeSession"]>[0],
  ): ReturnType<AcpxConsoleSessionService["closeSession"]> {
    this.calls.push({ method: "closeSession", input });
    return {
      session: { ...this.sessions[0], sessionState: "closed" as const },
      localClose: "closed" as const,
      providerClose: { status: "confirmed" as const },
    };
  }
  async listPendingRequests(): Promise<PendingInteraction[]> {
    return [
      {
        requestId: "request-1",
        acpxRecordId: session.acpxRecordId,
        kind: "permission",
        state: "pending",
        createdAt: "2026-08-12T00:00:00.000Z",
      },
    ];
  }
  async respondToPendingRequest(
    input: Parameters<AcpxConsoleSessionService["respondToPendingRequest"]>[0],
  ): Promise<PendingInteraction> {
    this.calls.push({ method: "respondToPendingRequest", input });
    return {
      requestId: input.requestId,
      acpxRecordId: input.acpxRecordId,
      kind: "permission",
      state: "answered",
      createdAt: "2026-08-12T00:00:00.000Z",
    };
  }
  async getTranscriptPage(): Promise<TimelinePage> {
    return { epoch: null, items: [], hasMore: false, coverage: "complete" };
  }
  subscribe(listener: (event: ServiceInvalidation) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  emit(event: ServiceInvalidation) {
    this.listener?.(event);
  }
  dispose() {}
}
