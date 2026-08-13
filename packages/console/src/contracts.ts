export type SessionState = "open" | "closed";
export type OwnerState = "absent" | "starting" | "online" | "unreachable" | "dead";
export type TurnState =
  | "idle"
  | "queued"
  | "starting"
  | "running"
  | "waiting_permission"
  | "waiting_elicitation"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";
export type ModeState = "unmanaged" | "stored" | "unverified" | "conflict";

export interface ConsoleAgent {
  agentId: string;
  label: string;
  supportsSessionList?: boolean;
}

export interface ConsoleSession {
  acpxRecordId: string;
  agentId: string;
  name?: string;
  cwd: string;
  sessionState: SessionState;
  ownerState: OwnerState;
  turnState: TurnState;
  queue: { depth: number };
  updatedAt: string;
  createdAt?: string;
  model?: string;
  mode?: string;
  desiredMode?: string;
  effectiveMode?: string;
  /** Optional only for compatibility with older installed acpx session services. */
  modeState?: ModeState;
  modeRemediation?: string;
  activeTurnId?: string;
  pendingCount?: number;
}

export interface ProviderSession {
  providerSessionId: string;
  title?: string;
  cwd?: string;
  updatedAt?: string;
}

export type TimelineItem =
  | {
      schema: "acpx.session_history_gap.v1";
      kind: "history_gap";
      reason: "legacy_retained" | "corrupt";
      message: string;
    }
  | {
      schema: "acpx.session_event.v1";
      acpx_record_id: string;
      epoch: string;
      seq: number;
      captured_at: string;
      direction: "inbound" | "outbound" | "internal";
      turn_id?: string;
      request_id?: string;
      payload: unknown;
    };

export interface TimelinePage {
  items: TimelineItem[];
  previousCursor?: string;
  hasMore: boolean;
  coverage: "complete" | "legacy_retained" | "incomplete";
  writeError?: string;
}

export interface PendingInteraction {
  requestId: string;
  acpxRecordId: string;
  kind: "permission" | "elicitation";
  state: "pending" | "answered" | "cancelled" | "expired" | "orphaned";
  createdAt: string;
  title?: string;
  detail?: string;
  options?: Array<{ optionId: string; name: string; kind?: string }>;
  schema?: unknown;
}

export interface ServiceInvalidation {
  type: "sessions" | "session" | "timeline" | "pending";
  acpxRecordId?: string;
  cursor?: string;
}

export interface AcpxConsoleSessionService {
  listAgents(input: { cwd: string }): Promise<ConsoleAgent[]>;
  listSessions(): Promise<ConsoleSession[]>;
  getSession(input: { acpxRecordId: string }): Promise<ConsoleSession | undefined>;
  listProviderSessions(input: {
    agentId: string;
    cwd: string;
    cursor?: string;
  }): Promise<{ sessions: ProviderSession[]; nextCursor?: string }>;
  createSession(input: {
    agentId: string;
    cwd: string;
    name?: string;
    mode?: string;
    model?: string;
    policy?: unknown;
    idempotencyKey: string;
  }): Promise<ConsoleSession>;
  adoptSession(input: {
    agentId: string;
    providerSessionId: string;
    cwd: string;
    name?: string;
    mode?: string;
    idempotencyKey: string;
  }): Promise<ConsoleSession>;
  enqueuePrompt(input: {
    acpxRecordId: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ turnId: string; admission: "started" | "queued" | "unknown" }>;
  cancelTurn(input: {
    acpxRecordId: string;
    turnId: string;
    idempotencyKey: string;
  }): Promise<{ turnId: string; state: TurnState }>;
  closeSession(input: { acpxRecordId: string; idempotencyKey: string }): Promise<ConsoleSession>;
  listPendingRequests(input: { acpxRecordId: string }): Promise<PendingInteraction[]>;
  respondToPendingRequest(input: {
    acpxRecordId: string;
    requestId: string;
    response: unknown;
    idempotencyKey: string;
  }): Promise<PendingInteraction>;
  getTranscriptPage(input: {
    acpxRecordId: string;
    before?: string;
    limit?: number;
  }): Promise<TimelinePage>;
  subscribe?(listener: (event: ServiceInvalidation) => void): () => void;
  dispose?(): Promise<void> | void;
}

export interface ConsoleBootstrap {
  version: 1;
  csrfToken: string;
  agents: ConsoleAgent[];
  sessions: ConsoleSession[];
  workspaceRoots: string[];
  server: { host: string; port: number; networkTrusted: boolean };
}
