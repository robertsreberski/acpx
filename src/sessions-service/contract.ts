import type {
  PendingRequestAnswer,
  PendingRequestKind,
  PendingRequestState,
} from "../session/pending-requests.js";
import type {
  SessionTimelineCoverage,
  SessionTimelineItem,
  SessionTimelinePage,
} from "../session/timeline.js";
import type {
  AuthPolicy,
  NonInteractivePermissionPolicy,
  PermissionMode,
  PermissionPolicy,
  PromptInput,
} from "../types.js";

export type AcpxSessionState = "open" | "closed";
export type AcpxOwnerState = "absent" | "starting" | "online" | "unreachable" | "dead";
export type AcpxTurnState =
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

export type AcpxQueuedTurn = {
  turnId: string;
  submittedAt: string;
  promptText?: string;
};

export type AcpxQueueState = {
  depth: number;
  turns: AcpxQueuedTurn[];
};

/**
 * Stored mode state deliberately does not overstate what a retained queue owner
 * is running. A matching last adapter report is still unverified while that
 * owner remains warm because an out-of-turn mode change can target a throwaway
 * adapter connection.
 */
export type AcpxModeState = "unmanaged" | "stored" | "unverified" | "conflict";

/** A registered invocation safe to expose to a browser-facing backend. */
export type AcpxRegisteredAgent = {
  agentId: string;
  label: string;
  capabilities: {
    /** Unknown until the adapter has been initialized at least once or queried directly. */
    sessionList: "supported" | "unsupported" | "unknown";
    /** Known from a retained local session, if one exists. */
    sessionResume: "supported" | "unsupported" | "unknown";
    /** Known from a retained local session, if one exists. */
    sessionLoad: "supported" | "unsupported" | "unknown";
  };
};

export type AcpxSessionSummary = {
  acpxRecordId: string;
  acpSessionId: string;
  agentSessionId?: string;
  agentId: string;
  name?: string;
  cwd: string;
  title?: string;
  sessionState: AcpxSessionState;
  ownerState: AcpxOwnerState;
  turnState: AcpxTurnState;
  queue: AcpxQueueState;
  createdAt: string;
  updatedAt: string;
  model?: string;
  /** Backwards-compatible display value; prefer the qualified fields below. */
  mode?: string;
  desiredMode?: string;
  /** Last mode reported by an adapter connection, not unqualified live-owner proof. */
  effectiveMode?: string;
  modeState: AcpxModeState;
  modeRemediation?: string;
  activeTurnId?: string;
  pendingCount: number;
};

export type AcpxSessionDetail = AcpxSessionSummary & {
  agentCapabilities?: {
    loadSession: boolean;
    resumeSession: boolean;
    closeSession: boolean;
    listSessions: boolean;
  };
};

export type AcpxProviderSession = {
  providerSessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
};

export type AcpxProviderSessionPage = {
  sessions: AcpxProviderSession[];
  nextCursor?: string;
};

export type AcpxPendingRequestOption = {
  optionId: string;
  name: string;
  kind?: string;
};

export type AcpxPendingRequest = {
  requestId: string;
  acpxRecordId: string;
  kind: PendingRequestKind;
  state: PendingRequestState;
  createdAt: string;
  expiresAt?: string;
  title?: string;
  detail?: string;
  options?: AcpxPendingRequestOption[];
  requestedSchema?: Record<string, unknown>;
  resolution?: {
    source: string;
    action?: string;
    optionId?: string;
    resolvedAt: string;
  };
};

export type AcpxMutationOperation =
  | "create_session"
  | "adopt_session"
  | "enqueue_prompt"
  | "cancel_turn"
  | "close_session"
  | "respond_pending_request";

export type AcpxMutationReceipt<T> = {
  operation: AcpxMutationOperation;
  idempotencyKey: string;
  replayed: boolean;
  result: T;
};

export type AcpxCreateSessionInput = {
  agentId: string;
  cwd: string;
  name?: string;
  mode?: string;
  model?: string;
  permissionMode?: PermissionMode;
  permissionPolicy?: PermissionPolicy;
  idempotencyKey: string;
};

export type AcpxAdoptSessionInput = AcpxCreateSessionInput & {
  providerSessionId: string;
};

export type AcpxEnqueuePromptInput = {
  acpxRecordId: string;
  prompt: PromptInput | string;
  permissionMode?: PermissionMode;
  permissionPolicy?: PermissionPolicy;
  deferMaxAgeMs?: number;
  idempotencyKey: string;
};

export type AcpxEnqueuePromptResult = {
  turnId: string;
  /**
   * `unknown` means queue admission may have succeeded. Keep and replay the
   * same idempotency key while reconciling this turn id; a fresh key is a new
   * prompt request and may intentionally create another turn.
   */
  admission: "started" | "queued" | "unknown";
};

export type AcpxCancelTurnInput = {
  acpxRecordId: string;
  turnId: string;
  idempotencyKey: string;
};

export type AcpxCancelTurnResult = {
  turnId: string;
  state: "cancelling" | "cancelled" | "completed" | "unknown";
};

export type AcpxCloseSessionInput = {
  acpxRecordId: string;
  idempotencyKey: string;
};

export type AcpxCloseSessionResult = {
  session: AcpxSessionDetail;
  localClose: "closed";
  providerClose:
    | { status: "confirmed" }
    | {
        status: "degraded";
        reason: "owner_absent" | "unsupported" | "provider_error";
      };
};

export type AcpxRespondPendingRequestInput = {
  acpxRecordId: string;
  requestId: string;
  answer: PendingRequestAnswer;
  responseTimeoutMs?: number;
  idempotencyKey: string;
};

export type AcpxTranscriptPage = {
  /** Authoritative durable-ledger generation; null means no ledger exists. */
  epoch: string | null;
  items: SessionTimelineItem[];
  previousCursor?: string;
  hasMore: boolean;
  coverage: SessionTimelineCoverage;
  /** True when another bounded compatibility-stream import pass is required. */
  legacyImportPending?: true;
  /** Present when the durable append-only transcript could not persist its latest write. */
  writeError?: string;
};

export type AcpxSessionInvalidation = {
  type: "sessions" | "session" | "timeline" | "pending";
  acpxRecordId?: string;
  cursor?: string;
};

export type AcpxSessionsServiceOptions = {
  cwd?: string;
  /** Restrict live invalidation polling to open sessions under these workspace roots. */
  subscriptionWorkspaceRoots?: string[];
  mcpConfigPath?: string;
  timelinePollMs?: number;
  /** Receives contained invalidation-poll failures; polling continues on the next interval. */
  onBackgroundError?: (error: unknown) => void | Promise<void>;
  /** Bound adapter initialization, list, create, adopt, and initial mode application. */
  adapterOperationTimeoutMs?: number;
  /** Default bound for waiting on a queue owner to confirm a pending-request answer. */
  pendingResponseTimeoutMs?: number;
  /** Primarily for embedding in a process with its own resolved credentials. */
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
};

export interface AcpxSessionService {
  listAgents(input: { cwd: string }): Promise<AcpxRegisteredAgent[]>;
  listSessions(): Promise<AcpxSessionSummary[]>;
  getSession(input: { acpxRecordId: string }): Promise<AcpxSessionDetail | undefined>;
  listProviderSessions(input: {
    agentId: string;
    cwd: string;
    cursor?: string;
  }): Promise<AcpxProviderSessionPage>;
  createSession(input: AcpxCreateSessionInput): Promise<AcpxMutationReceipt<AcpxSessionDetail>>;
  adoptSession(input: AcpxAdoptSessionInput): Promise<AcpxMutationReceipt<AcpxSessionDetail>>;
  enqueuePrompt(
    input: AcpxEnqueuePromptInput,
  ): Promise<AcpxMutationReceipt<AcpxEnqueuePromptResult>>;
  cancelTurn(input: AcpxCancelTurnInput): Promise<AcpxMutationReceipt<AcpxCancelTurnResult>>;
  closeSession(input: AcpxCloseSessionInput): Promise<AcpxMutationReceipt<AcpxCloseSessionResult>>;
  listPendingRequests(input: { acpxRecordId: string }): Promise<AcpxPendingRequest[]>;
  respondToPendingRequest(
    input: AcpxRespondPendingRequestInput,
  ): Promise<AcpxMutationReceipt<AcpxPendingRequest>>;
  getTranscriptPage(input: {
    acpxRecordId: string;
    before?: string;
    limit?: number;
  }): Promise<AcpxTranscriptPage>;
  /** Alias retained for UI servers whose route vocabulary uses "timeline". */
  readTimeline(input: {
    acpxRecordId: string;
    before?: string;
    limit?: number;
  }): Promise<SessionTimelinePage>;
  subscribe(listener: (event: AcpxSessionInvalidation) => void): () => void;
  dispose(): void;
}
