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

export interface AgentSummary {
  readonly id: string;
  readonly label: string;
  readonly modes?: readonly { readonly id: string; readonly label: string }[];
  readonly models?: readonly { readonly id: string; readonly label: string }[];
  readonly canBrowseSessions?: boolean;
}

export interface WorkspaceRoot {
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

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
  readonly pendingCount: number;
  readonly queuedCount: number;
  readonly activeTurnId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActivityAt: string;
  readonly historyCoverage?: "complete" | "legacy_retained";
}

export interface SessionDetail extends SessionSummary {
  readonly providerSessionId?: string;
  readonly mode?: string;
  readonly model?: string;
  readonly permissionPolicy?: unknown;
  readonly closeReason?: string;
}

export type EventRole = "user" | "assistant" | "system";

export interface TranscriptEvent {
  readonly id: string;
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
  readonly previousCursor?: string;
  readonly coverage: "complete" | "legacy_retained";
  readonly gap?: { readonly reason: string; readonly earliestAvailableAt?: string };
  readonly writeError?: string;
}

export interface PermissionOption {
  readonly id: string;
  readonly label: string;
  readonly kind?: string;
}

export type ElicitationProperty = {
  readonly type?: "string" | "number" | "integer" | "boolean" | "array";
  readonly title?: string;
  readonly description?: string;
  readonly enum?: readonly (string | number)[];
  readonly oneOf?: readonly { readonly const: string | number; readonly title?: string }[];
  readonly items?: ElicitationProperty;
};

export interface PendingInteraction {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: "permission" | "elicitation";
  readonly state: "pending" | "answered" | "cancelled" | "expired" | "orphaned";
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

export interface BootstrapSnapshot {
  readonly agents: readonly AgentSummary[];
  readonly workspaceRoots: readonly WorkspaceRoot[];
  readonly sessions: readonly SessionSummary[];
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
}

export interface MutationReceipt {
  readonly accepted: boolean;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly state?: "started" | "queued" | "known";
}

export interface ConsoleNotice {
  readonly id: number;
  readonly tone: "info" | "success" | "error";
  readonly message: string;
}
