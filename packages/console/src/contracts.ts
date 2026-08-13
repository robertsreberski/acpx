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
  queue: {
    depth: number;
    turns: Array<{ turnId: string; submittedAt: string; promptText?: string }>;
  };
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
  /** Authoritative durable-ledger generation; null means no ledger exists. */
  epoch: string | null;
  items: TimelineItem[];
  previousCursor?: string;
  hasMore: boolean;
  coverage: "complete" | "legacy_retained" | "incomplete";
  /** True while the server has more retained compatibility history to import. */
  legacyImportPending?: true;
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

export interface ProbeOption {
  value: string;
  label: string;
  description?: string;
}

export type ProbeCatalog =
  | { advertised: false }
  | { advertised: true; currentValue?: string; options: ProbeOption[] };

/**
 * Discovering an agent's modes and models is best-effort: an older installed
 * acpx cannot do it, and an adapter can refuse. Every outcome is a normal
 * answer the dialog can act on, so none of them is an HTTP failure.
 */
export type ProbeSessionOptionsResult =
  | {
      status: "ready";
      modes: ProbeCatalog;
      models: ProbeCatalog;
      cleanup: "closed" | "unsupported" | "failed";
      strandedSessionId?: string;
    }
  | { status: "unsupported"; reason: "older_acpx" }
  | {
      status: "failed";
      phase: "start" | "session_new";
      code: "auth_required" | "timeout" | "spawn_failed" | "protocol_error";
      message: string;
      cleanup: "closed" | "unsupported" | "failed";
      strandedSessionId?: string;
    };

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
  probeSessionOptions?(input: {
    agentId: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<ProbeSessionOptionsResult>;
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
  closeSession(input: {
    acpxRecordId: string;
    idempotencyKey: string;
  }): Promise<ConsoleCloseSessionResult>;
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

export interface ConsoleCloseSessionResult {
  session: ConsoleSession;
  localClose: "closed";
  providerClose:
    | { status: "confirmed" }
    | {
        status: "degraded";
        reason: "owner_absent" | "unsupported" | "provider_error";
      };
}

/**
 * A directory holding sessions the console declined to serve.
 *
 * Filtering is a security boundary and stays exactly as strict, but silently
 * returning a short list reads as "this is all your work". Reporting the
 * directory and the count — never the sessions themselves — lets the operator
 * see that something was withheld and, when the directory still exists, grant it.
 *
 * `missing` is not authorizable: the workspace has been deleted, so no grant can
 * ever resolve it and the records are only good for closing.
 */
export interface ConsoleHiddenWorkspace {
  path: string;
  sessionCount: number;
  reason: "unauthorized" | "missing";
}

export interface ConsoleBootstrap {
  version: 1;
  csrfToken: string;
  agents: ConsoleAgent[];
  sessions: ConsoleSession[];
  hiddenWorkspaces: ConsoleHiddenWorkspace[];
  workspaceRoots: string[];
  server: { host: string; port: number; networkTrusted: boolean };
}
