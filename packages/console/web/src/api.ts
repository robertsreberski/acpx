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

export class MutationRetryStateError extends Error {
  readonly code: "CAPACITY_REACHED" | "STORAGE_UNAVAILABLE";

  constructor(code: "CAPACITY_REACHED" | "STORAGE_UNAVAILABLE", cause?: unknown) {
    super(
      code === "CAPACITY_REACHED"
        ? "Too many mutations still have an unknown outcome. Retry or reconcile those actions before starting a different one."
        : "Safe mutation retries are unavailable because this tab's session storage cannot be used. Enable session storage and reload before trying the action again.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "MutationRetryStateError";
    this.code = code;
  }
}

const json = async <T>(response: Response): Promise<T> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (response.ok) {
      throw error;
    }
  }
  const typedBody = body as
    | {
        readonly error?: { readonly message?: string; readonly code?: string };
        readonly message?: string;
      }
    | T
    | undefined;
  if (!response.ok) {
    const errorBody = typedBody as
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
  return typedBody as T;
};

const idempotencyKey = (): string => crypto.randomUUID();
const MAX_AMBIGUOUS_MUTATIONS = 64;
const AMBIGUOUS_MUTATION_TTL_MS = 24 * 60 * 60 * 1_000;
const AMBIGUOUS_MUTATION_STORAGE_KEY = "acpx.console.ambiguous_mutations.v1";
const AMBIGUOUS_MUTATION_SCHEMA = "acpx.console_ambiguous_mutations.v1";

interface MutationRetryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PersistedMutationKey {
  readonly fingerprint: string;
  readonly key: string;
  readonly created_at: number;
  readonly expires_at: number;
}

interface ConsoleApiOptions {
  readonly storage?: MutationRetryStorage | null;
  readonly now?: () => number;
}

const mutationFingerprint = async (
  method: "DELETE" | "PATCH" | "POST" | "PUT",
  path: string,
  serializedBody: string | undefined,
): Promise<string> => {
  const bytes = new TextEncoder().encode(`${method}\n${path}\n${serializedBody ?? ""}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const sessionMutationStorage = (): MutationRetryStorage | undefined => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
};

const persistedMutationKey = (value: unknown): PersistedMutationKey => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mutation retry entry is not an object.");
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(entry.fingerprint) ||
    typeof entry.key !== "string" ||
    entry.key.length === 0 ||
    entry.key.length > 128 ||
    typeof entry.created_at !== "number" ||
    !Number.isSafeInteger(entry.created_at) ||
    entry.created_at < 0 ||
    typeof entry.expires_at !== "number" ||
    !Number.isSafeInteger(entry.expires_at) ||
    entry.expires_at - entry.created_at !== AMBIGUOUS_MUTATION_TTL_MS
  ) {
    throw new Error("Mutation retry entry is invalid.");
  }
  return {
    fingerprint: entry.fingerprint,
    key: entry.key,
    created_at: entry.created_at,
    expires_at: entry.expires_at,
  };
};

export class ConsoleApi {
  #csrfToken: string | undefined;
  readonly #ambiguousMutationKeys = new Map<string, PersistedMutationKey>();
  readonly #storage: MutationRetryStorage | undefined;
  readonly #now: () => number;
  #retryStateError: MutationRetryStateError | undefined;

  constructor(options: ConsoleApiOptions = {}) {
    this.#storage =
      options.storage === undefined ? sessionMutationStorage() : (options.storage ?? undefined);
    this.#now = options.now ?? Date.now;
    this.#loadMutationKeys();
  }

  #loadMutationKeys(): void {
    if (!this.#storage) {
      this.#retryStateError = new MutationRetryStateError("STORAGE_UNAVAILABLE");
      return;
    }
    try {
      const serialized = this.#storage.getItem(AMBIGUOUS_MUTATION_STORAGE_KEY);
      if (serialized === null) {
        return;
      }
      const value = JSON.parse(serialized) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Mutation retry state is not an object.");
      }
      const record = value as Record<string, unknown>;
      if (record.schema !== AMBIGUOUS_MUTATION_SCHEMA || !Array.isArray(record.entries)) {
        throw new Error("Mutation retry state has an unsupported schema.");
      }
      const now = this.#now();
      const activeEntries = record.entries.map(persistedMutationKey).filter((entry) => {
        return entry.expires_at > now;
      });
      if (activeEntries.length > MAX_AMBIGUOUS_MUTATIONS) {
        throw new MutationRetryStateError("CAPACITY_REACHED");
      }
      for (const entry of activeEntries) {
        if (this.#ambiguousMutationKeys.has(entry.fingerprint)) {
          throw new Error("Mutation retry state contains a duplicate fingerprint.");
        }
        this.#ambiguousMutationKeys.set(entry.fingerprint, entry);
      }
      if (activeEntries.length !== record.entries.length) {
        this.#persistMutationKeys(this.#ambiguousMutationKeys);
      }
    } catch (error) {
      this.#ambiguousMutationKeys.clear();
      this.#retryStateError =
        error instanceof MutationRetryStateError
          ? error
          : new MutationRetryStateError("STORAGE_UNAVAILABLE", error);
    }
  }

  #persistMutationKeys(entries: ReadonlyMap<string, PersistedMutationKey>): void {
    if (!this.#storage) {
      throw new MutationRetryStateError("STORAGE_UNAVAILABLE");
    }
    try {
      if (entries.size === 0) {
        this.#storage.removeItem(AMBIGUOUS_MUTATION_STORAGE_KEY);
        return;
      }
      this.#storage.setItem(
        AMBIGUOUS_MUTATION_STORAGE_KEY,
        JSON.stringify({
          schema: AMBIGUOUS_MUTATION_SCHEMA,
          entries: [...entries.values()],
        }),
      );
    } catch (error) {
      const stateError = new MutationRetryStateError("STORAGE_UNAVAILABLE", error);
      this.#retryStateError = stateError;
      throw stateError;
    }
  }

  #pruneExpiredMutationKeys(): void {
    if (this.#retryStateError) {
      throw this.#retryStateError;
    }
    const now = this.#now();
    const activeEntries = new Map(
      [...this.#ambiguousMutationKeys].filter(([, entry]) => entry.expires_at > now),
    );
    if (activeEntries.size === this.#ambiguousMutationKeys.size) {
      return;
    }
    this.#persistMutationKeys(activeEntries);
    this.#ambiguousMutationKeys.clear();
    for (const [fingerprint, entry] of activeEntries) {
      this.#ambiguousMutationKeys.set(fingerprint, entry);
    }
  }

  #reserveMutationKey(fingerprint: string, requestedKey?: string): string {
    this.#pruneExpiredMutationKeys();
    const existing = this.#ambiguousMutationKeys.get(fingerprint);
    if (existing) {
      return existing.key;
    }
    if (this.#ambiguousMutationKeys.size >= MAX_AMBIGUOUS_MUTATIONS) {
      throw new MutationRetryStateError("CAPACITY_REACHED");
    }
    const now = this.#now();
    const entry: PersistedMutationKey = {
      fingerprint,
      key: requestedKey ?? idempotencyKey(),
      created_at: now,
      expires_at: now + AMBIGUOUS_MUTATION_TTL_MS,
    };
    const nextEntries = new Map(this.#ambiguousMutationKeys).set(fingerprint, entry);
    this.#persistMutationKeys(nextEntries);
    this.#ambiguousMutationKeys.set(fingerprint, entry);
    return entry.key;
  }

  #releaseMutationKey(fingerprint: string, requestKey: string): void {
    const existing = this.#ambiguousMutationKeys.get(fingerprint);
    if (existing?.key !== requestKey) {
      return;
    }
    const nextEntries = new Map(this.#ambiguousMutationKeys);
    nextEntries.delete(fingerprint);
    this.#persistMutationKeys(nextEntries);
    this.#ambiguousMutationKeys.delete(fingerprint);
  }

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
    const fingerprint = await mutationFingerprint(method, path, serializedBody);
    const requestKey = this.#reserveMutationKey(fingerprint, key);
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
      throw new MutationTransportUnknownError(error);
    }
    if (response.status === 403 && allowCsrfRefresh) {
      let snapshot: BootstrapSnapshot;
      try {
        snapshot = await this.bootstrap();
      } catch (error) {
        this.#releaseMutationKey(fingerprint, requestKey);
        throw error;
      }
      this.setCsrfToken(snapshot.csrfToken);
      return await this.mutate<T>(path, body, method, requestKey, false);
    }
    try {
      const result = await json<T>(response);
      this.#releaseMutationKey(fingerprint, requestKey);
      return result;
    } catch (error) {
      if (response.ok) {
        throw new MutationTransportUnknownError(error);
      }
      this.#releaseMutationKey(fingerprint, requestKey);
      throw error;
    }
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
