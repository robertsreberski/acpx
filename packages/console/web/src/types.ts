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

export interface AgentSummary {
  readonly id: string;
  readonly label: string;
  readonly canBrowseSessions?: boolean;
}

export interface WorkspaceRoot {
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

export interface WorkspaceSuggestion {
  readonly path: string;
  readonly label: string;
  /** False when picking it would need an explicit authorization first. */
  readonly authorized: boolean;
}

export interface ProbeOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export type ProbeCatalog =
  | { readonly advertised: false }
  | {
      readonly advertised: true;
      readonly currentValue?: string;
      readonly options: readonly ProbeOption[];
    };

export type SessionOptionsProbe =
  | {
      readonly status: "ready";
      readonly modes: ProbeCatalog;
      readonly models: ProbeCatalog;
      readonly cleanup: "closed" | "unsupported" | "failed";
      readonly strandedSessionId?: string;
    }
  | { readonly status: "unsupported"; readonly reason: "older_acpx" }
  | {
      readonly status: "failed";
      readonly phase: "start" | "session_new";
      readonly code: "auth_required" | "timeout" | "spawn_failed" | "protocol_error";
      readonly message: string;
      readonly cleanup: "closed" | "unsupported" | "failed";
      readonly strandedSessionId?: string;
    };

export interface SessionSummary {
  readonly id: string;
  readonly name: string;
  readonly agentId: string;
  readonly agentLabel: string;
  readonly cwd: string;
  readonly repo?: string;
  readonly branch?: string;
  readonly sessionState: SessionState;
  readonly ownerState: OwnerState;
  readonly turnState: TurnState;
  /** Harness identity. The session list renders these, so they live on the summary. */
  readonly model?: string;
  readonly mode?: string;
  readonly desiredMode?: string;
  readonly effectiveMode?: string;
  readonly pendingCount: number;
  readonly queuedCount: number;
  readonly queuedTurns: readonly {
    readonly id: string;
    readonly text: string;
    readonly submittedAt: string;
  }[];
  readonly activeTurnId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActivityAt: string;
  readonly historyCoverage?: "complete" | "legacy_retained" | "incomplete";
}

export interface SessionDetail extends SessionSummary {
  readonly providerSessionId?: string;
  readonly modeState: ModeState;
  readonly modeRemediation?: string;
  readonly permissionPolicy?: unknown;
  readonly closeReason?: string;
}

export type EventRole = "user" | "assistant" | "system";

export interface TranscriptEvent {
  readonly id: string;
  /** Durable ledger generation; sequence numbers restart when this changes. */
  readonly epoch?: string;
  readonly sequence: number;
  /** Raw events folded into this projected item, retained for lossless page merging. */
  readonly sourceEvents?: readonly TranscriptEvent[];
  readonly occurredAt: string;
  readonly direction?: "client_to_agent" | "agent_to_client" | "internal";
  readonly turnId?: string;
  readonly requestId?: string;
  readonly kind: string;
  readonly role?: EventRole;
  readonly text?: string;
  readonly title?: string;
  readonly status?: string;
  readonly toolName?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly payload?: unknown;
}

export interface TimelinePage {
  readonly events: readonly TranscriptEvent[];
  /** Authoritative durable-ledger generation; null means no ledger exists. */
  readonly epoch: string | null;
  readonly previousCursor?: string;
  readonly coverage: "complete" | "legacy_retained" | "incomplete";
  /** True while another bounded retained-history import pass is required. */
  readonly legacyImportPending?: true;
  readonly gap?: {
    readonly reason: "legacy_retained" | "corrupt";
    readonly message: string;
    readonly earliestAvailableAt?: string;
  };
  readonly continuityIssue?: {
    readonly reason: "refresh_gap" | "epoch_changed";
    readonly message: string;
  };
  readonly writeError?: string;
}

export interface PermissionOption {
  readonly id: string;
  readonly label: string;
  readonly kind?: string;
}

export type ElicitationProperty = {
  readonly type?: string;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly enum?: readonly string[] | null;
  readonly oneOf?: readonly { readonly const: string; readonly title?: string | null }[] | null;
  readonly items?: ElicitationProperty | null;
  readonly anyOf?: readonly { readonly const: string; readonly title?: string | null }[] | null;
  readonly minItems?: number | null;
  readonly maxItems?: number | null;
  readonly minLength?: number | null;
  readonly maxLength?: number | null;
  readonly pattern?: string | null;
  readonly format?: "email" | "uri" | "date" | "date-time" | null;
  readonly minimum?: number | null;
  readonly maximum?: number | null;
  readonly default?: string | number | boolean | readonly string[] | null;
};

export interface PendingInteraction {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: "permission" | "elicitation";
  readonly state: "pending" | "answered" | "cancelled" | "expired" | "orphaned";
  /** A prior response crossed the write boundary but has not been confirmed. */
  readonly responseOutcome?: "unknown";
  readonly createdAt: string;
  readonly title: string;
  readonly detail?: string;
  readonly options?: readonly PermissionOption[];
  readonly elicitation?: {
    readonly message: string;
    readonly required?: readonly string[];
    readonly properties: Readonly<Record<string, ElicitationProperty>>;
  };
}

export interface ProviderSession {
  readonly id: string;
  readonly label: string;
  readonly updatedAt?: string;
  readonly cwd?: string;
  readonly alreadyAdopted?: boolean;
  readonly acpxRecordId?: string;
}

/**
 * A directory whose sessions the console withheld.
 *
 * `unauthorized` can be granted from the UI; `missing` means the workspace is
 * gone, so there is nothing to grant and the records can only be closed.
 */
export interface HiddenWorkspace {
  readonly path: string;
  readonly sessionCount: number;
  readonly reason: "unauthorized" | "missing";
}

export interface BootstrapSnapshot {
  readonly agents: readonly AgentSummary[];
  readonly workspaceRoots: readonly WorkspaceRoot[];
  readonly sessions: readonly SessionSummary[];
  readonly hiddenWorkspaces: readonly HiddenWorkspace[];
  readonly csrfToken?: string;
  readonly trustNetwork?: boolean;
  readonly version?: string;
}

export interface CreateSessionInput {
  readonly agentId: string;
  readonly cwd: string;
  readonly name?: string;
  readonly mode?: string;
  readonly model?: string;
  readonly permissionPolicy: "defer-risky";
}

export interface AdoptSessionInput {
  readonly agentId: string;
  readonly providerSessionId: string;
  readonly cwd: string;
  readonly name?: string;
  readonly mode?: string;
}

export interface MutationReceipt {
  readonly accepted: boolean;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly state?: "started" | "queued" | "unknown";
}

export interface CloseSessionResult {
  readonly session: SessionDetail;
  readonly localClose: "closed";
  readonly providerClose:
    | { readonly status: "confirmed" }
    | {
        readonly status: "degraded";
        readonly reason: "owner_absent" | "unsupported" | "provider_error";
      };
}

export interface ConsoleNotice {
  readonly id: number;
  readonly tone: "info" | "success" | "error";
  readonly message: string;
}
