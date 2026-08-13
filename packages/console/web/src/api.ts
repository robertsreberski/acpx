import {
  projectTimelineEvent,
  type WireTimelineEvent,
  type WireTimelineGap,
} from "./timeline-projector";
import type {
  AdoptSessionInput,
  BootstrapSnapshot,
  CloseSessionResult,
  CreateSessionInput,
  MutationReceipt,
  PendingInteraction,
  ProviderSession,
  SessionDetail,
  SessionSummary,
  TimelinePage,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class MutationTransportUnknownError extends Error {
  constructor(cause: unknown) {
    super(
      "The mutation response was lost. Retry the same action to reconcile it without creating a duplicate.",
      { cause },
    );
    this.name = "MutationTransportUnknownError";
  }
}

const json = async <T>(response: Response): Promise<T> => {
  const body = (await response.json().catch(() => undefined)) as
    | {
        readonly error?: { readonly message?: string; readonly code?: string };
        readonly message?: string;
      }
    | T
    | undefined;
  if (!response.ok) {
    const errorBody = body as
      | {
          readonly error?: { readonly message?: string; readonly code?: string };
          readonly message?: string;
        }
      | undefined;
    throw new ApiError(
      errorBody?.error?.message ?? errorBody?.message ?? `Request failed (${response.status})`,
      response.status,
      errorBody?.error?.code,
    );
  }
  return body as T;
};

const idempotencyKey = (): string => crypto.randomUUID();
const MAX_AMBIGUOUS_MUTATIONS = 64;

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

export class ConsoleApi {
  #csrfToken: string | undefined;
  readonly #ambiguousMutationKeys = new Map<string, string>();

  setCsrfToken(value: string | undefined): void {
    this.#csrfToken = value;
  }

  async get<T>(path: string): Promise<T> {
    return await json<T>(await fetch(path, { headers: { Accept: "application/json" } }));
  }

  async mutate<T>(
    path: string,
    body: unknown,
    method: "DELETE" | "PATCH" | "POST" | "PUT" = "POST",
    key?: string,
    allowCsrfRefresh = true,
  ): Promise<T> {
    const serializedBody = JSON.stringify(body);
    const fingerprint = `${method}\n${path}\n${serializedBody}`;
    const requestKey = key ?? this.#ambiguousMutationKeys.get(fingerprint) ?? idempotencyKey();
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": requestKey,
    };
    if (this.#csrfToken) {
      headers["X-CSRF-Token"] = this.#csrfToken;
    }
    const request = async (): Promise<Response> =>
      await fetch(path, {
        method,
        headers,
        body: serializedBody,
      });
    let response: Response;
    try {
      try {
        response = await request();
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw error;
        }
        response = await request();
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      if (!this.#ambiguousMutationKeys.has(fingerprint)) {
        if (this.#ambiguousMutationKeys.size >= MAX_AMBIGUOUS_MUTATIONS) {
          const oldest = this.#ambiguousMutationKeys.keys().next().value;
          if (oldest !== undefined) {
            this.#ambiguousMutationKeys.delete(oldest);
          }
        }
      }
      this.#ambiguousMutationKeys.set(fingerprint, requestKey);
      throw new MutationTransportUnknownError(error);
    }
    if (response.status === 403 && allowCsrfRefresh) {
      const snapshot = await this.bootstrap();
      this.setCsrfToken(snapshot.csrfToken);
      return await this.mutate<T>(path, body, method, requestKey, false);
    }
    const result = await json<T>(response);
    if (this.#ambiguousMutationKeys.get(fingerprint) === requestKey) {
      this.#ambiguousMutationKeys.delete(fingerprint);
    }
    return result;
  }

  bootstrap(): Promise<BootstrapSnapshot> {
    return this.get<WireBootstrap>("/api/v1/bootstrap").then((snapshot) => ({
      agents: snapshot.agents.map((agent) => ({
        id: agent.agentId,
        label: agent.label,
        canBrowseSessions: agent.supportsSessionList,
      })),
      workspaceRoots: snapshot.workspaceRoots.map((path) => ({
        id: path,
        label: path.split("/").findLast(Boolean) ?? path,
        path,
      })),
      sessions: snapshot.sessions.map(sessionSummary),
      csrfToken: snapshot.csrfToken,
      trustNetwork: snapshot.server.networkTrusted,
      version: String(snapshot.version),
    }));
  }

  session(id: string): Promise<SessionDetail> {
    return this.get<{ readonly session: WireSession }>(
      `/api/v1/sessions/${encodeURIComponent(id)}`,
    ).then(({ session }) => sessionDetail(session));
  }

  timeline(id: string, before?: string): Promise<TimelinePage> {
    const search = new URLSearchParams({ limit: "80" });
    if (before) {
      search.set("before", before);
    }
    return this.get<WireTimelinePage>(
      `/api/v1/sessions/${encodeURIComponent(id)}/timeline?${search}`,
    ).then((page) => {
      const gap = page.items.find((item): item is WireTimelineGap => item.kind === "history_gap");
      return {
        events: page.items
          .filter((item): item is WireTimelineEvent => item.kind !== "history_gap")
          .map(projectTimelineEvent),
        previousCursor: page.previousCursor,
        coverage: page.coverage,
        gap: gap ? { reason: gap.reason, message: gap.message } : undefined,
        writeError: page.writeError,
      };
    });
  }

  pending(id: string): Promise<readonly PendingInteraction[]> {
    return this.get<{ readonly pending: readonly WirePendingInteraction[] }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/pending`,
    ).then(({ pending }) => pending.map(pendingInteraction));
  }

  createSession(input: CreateSessionInput): Promise<SessionDetail> {
    const { permissionPolicy: policy, ...fields } = input;
    return this.mutate<{ readonly session: WireSession }>("/api/v1/sessions", {
      ...fields,
      policy,
    }).then(({ session }) => sessionDetail(session));
  }

  providerSessions(
    agentId: string,
    cwd: string,
    cursor?: string,
  ): Promise<{
    readonly sessions: readonly ProviderSession[];
    readonly nextCursor?: string;
  }> {
    const search = new URLSearchParams();
    search.set("cwd", cwd);
    if (cursor) {
      search.set("cursor", cursor);
    }
    return this.get<{
      readonly sessions: readonly {
        readonly providerSessionId: string;
        readonly title?: string;
        readonly cwd?: string;
        readonly updatedAt?: string;
        readonly alreadyAdopted?: boolean;
        readonly acpxRecordId?: string;
      }[];
      readonly nextCursor?: string;
    }>(`/api/v1/agents/${encodeURIComponent(agentId)}/sessions?${search}`).then((page) => ({
      ...page,
      sessions: page.sessions.map((session) => ({
        id: session.providerSessionId,
        label: session.title ?? session.providerSessionId,
        updatedAt: session.updatedAt,
        cwd: session.cwd,
        alreadyAdopted: session.alreadyAdopted,
        acpxRecordId: session.acpxRecordId,
      })),
    }));
  }

  adoptSession(input: AdoptSessionInput): Promise<SessionDetail> {
    return this.mutate<{ readonly session: WireSession }>("/api/v1/sessions/adopt", input).then(
      ({ session }) => sessionDetail(session),
    );
  }

  sendPrompt(sessionId: string, text: string): Promise<MutationReceipt> {
    return this.mutate<WireMutationReceipt>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
      { text },
    ).then((receipt) => ({
      accepted: true,
      sessionId,
      turnId: receipt.turnId,
      state: receipt.admission,
    }));
  }

  cancelTurn(sessionId: string, turnId: string): Promise<void> {
    return this.mutate(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
      {},
    );
  }

  closeSession(sessionId: string): Promise<CloseSessionResult> {
    return this.mutate<{ readonly close: WireCloseSessionResult }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/close`,
      {},
    ).then(({ close }) => ({
      ...close,
      session: sessionDetail(close.session),
    }));
  }

  answerInteraction(sessionId: string, requestId: string, answer: unknown): Promise<void> {
    return this.mutate(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/pending/${encodeURIComponent(requestId)}/responses`,
      { response: answer },
    );
  }
}

export const api = new ConsoleApi();

interface WireBootstrap {
  readonly version: number;
  readonly csrfToken: string;
  readonly agents: readonly {
    readonly agentId: string;
    readonly label: string;
    readonly supportsSessionList?: boolean;
  }[];
  readonly sessions: readonly WireSession[];
  readonly workspaceRoots: readonly string[];
  readonly server: { readonly networkTrusted: boolean };
}

interface WireSession {
  readonly acpxRecordId: string;
  readonly agentId: string;
  readonly agentLabel?: string;
  readonly name?: string;
  readonly title?: string;
  readonly cwd: string;
  readonly repo?: string;
  readonly branch?: string;
  readonly sessionState: SessionSummary["sessionState"];
  readonly ownerState: SessionSummary["ownerState"];
  readonly turnState: SessionSummary["turnState"];
  readonly queue: {
    readonly depth: number;
    readonly turns?: readonly {
      readonly turnId: string;
      readonly submittedAt: string;
      readonly promptText?: string;
    }[];
  };
  readonly updatedAt: string;
  readonly createdAt?: string;
  readonly model?: string;
  readonly mode?: string;
  readonly desiredMode?: string;
  readonly effectiveMode?: string;
  readonly modeState?: SessionDetail["modeState"];
  readonly modeRemediation?: string;
  readonly activeTurnId?: string;
  readonly pendingCount?: number;
  readonly providerSessionId?: string;
  readonly acpSessionId?: string;
  readonly permissionPolicy?: unknown;
  readonly closeReason?: string;
}

interface WireTimelinePage {
  readonly items: readonly (WireTimelineEvent | WireTimelineGap)[];
  readonly previousCursor?: string;
  readonly hasMore: boolean;
  readonly coverage: "complete" | "legacy_retained" | "incomplete";
  readonly writeError?: string;
}

interface WirePendingInteraction {
  readonly requestId: string;
  readonly acpxRecordId: string;
  readonly kind: "permission" | "elicitation";
  readonly state: PendingInteraction["state"];
  readonly createdAt: string;
  readonly title?: string;
  readonly detail?: string;
  readonly options?: readonly {
    readonly optionId: string;
    readonly name: string;
    readonly kind?: string;
  }[];
  readonly schema?: unknown;
}

interface WireMutationReceipt {
  readonly turnId: string;
  readonly admission: "started" | "queued" | "unknown";
}

interface WireCloseSessionResult {
  readonly session: WireSession;
  readonly localClose: "closed";
  readonly providerClose: CloseSessionResult["providerClose"];
}

const sessionSummary = (session: WireSession): SessionSummary => ({
  id: session.acpxRecordId,
  name: session.name ?? session.title ?? session.acpxRecordId,
  agentId: session.agentId,
  agentLabel: session.agentLabel ?? session.agentId,
  cwd: session.cwd,
  repo: session.repo,
  branch: session.branch,
  sessionState: session.sessionState,
  ownerState: session.ownerState,
  turnState: session.turnState,
  pendingCount: session.pendingCount ?? 0,
  queuedCount: session.queue.depth,
  queuedTurns: (session.queue.turns ?? []).map((turn) => ({
    id: turn.turnId,
    text: turn.promptText ?? "Queued follow-up",
    submittedAt: turn.submittedAt,
  })),
  activeTurnId: session.activeTurnId,
  createdAt: session.createdAt ?? session.updatedAt,
  updatedAt: session.updatedAt,
  lastActivityAt: session.updatedAt,
});

const sessionDetail = (session: WireSession): SessionDetail => ({
  ...sessionSummary(session),
  providerSessionId: session.providerSessionId ?? session.acpSessionId,
  mode: session.mode,
  desiredMode: session.desiredMode,
  effectiveMode: session.effectiveMode,
  modeState: session.modeState ?? "unmanaged",
  modeRemediation: session.modeRemediation,
  model: session.model,
  permissionPolicy: session.permissionPolicy,
  closeReason: session.closeReason,
});

const payloadRecord = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};

const pendingInteraction = (interaction: WirePendingInteraction): PendingInteraction => {
  const schema = payloadRecord(interaction.schema);
  const properties = payloadRecord(schema.properties);
  const safeProperties = Object.fromEntries(
    Object.entries(properties).map(([name, property]) => [
      name,
      property && typeof property === "object" && !Array.isArray(property)
        ? property
        : { type: "unsupported" },
    ]),
  );
  return {
    id: interaction.requestId,
    sessionId: interaction.acpxRecordId,
    kind: interaction.kind,
    state: interaction.state,
    createdAt: interaction.createdAt,
    title:
      interaction.title ??
      (interaction.kind === "elicitation" ? "Agent question" : "Permission request"),
    detail: interaction.detail,
    options: interaction.options?.map((option) => ({
      id: option.optionId,
      label: option.name,
      kind: option.kind,
    })),
    elicitation:
      interaction.kind === "elicitation"
        ? {
            message: interaction.detail ?? interaction.title ?? "The agent needs an answer.",
            required: Array.isArray(schema.required)
              ? schema.required.filter((item): item is string => typeof item === "string")
              : [],
            properties: safeProperties,
          }
        : undefined,
  };
};
