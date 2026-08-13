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
  SessionOptionsProbe,
  SessionSummary,
  TimelinePage,
  WorkspaceSuggestion,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class PendingResponseOutcomeUnknownError extends Error {
  constructor() {
    super(
      "The answer may still be applied. Wait for the request state to settle; a conflicting answer is blocked.",
    );
    this.name = "PendingResponseOutcomeUnknownError";
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
        readonly error?: {
          readonly message?: string;
          readonly code?: string;
          readonly details?: unknown;
        };
        readonly message?: string;
      }
    | T
    | undefined;
  if (!response.ok) {
    const errorBody = typedBody as
      | {
          readonly error?: {
            readonly message?: string;
            readonly code?: string;
            readonly details?: unknown;
          };
          readonly message?: string;
        }
      | undefined;
    throw new ApiError(
      errorBody?.error?.message ?? errorBody?.message ?? `Request failed (${response.status})`,
      response.status,
      errorBody?.error?.code,
      errorBody?.error?.details,
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
  readonly exclusive_scope?: string;
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
    entry.expires_at - entry.created_at !== AMBIGUOUS_MUTATION_TTL_MS ||
    (entry.exclusive_scope !== undefined &&
      (typeof entry.exclusive_scope !== "string" || entry.exclusive_scope.length === 0))
  ) {
    throw new Error("Mutation retry entry is invalid.");
  }
  return {
    fingerprint: entry.fingerprint,
    key: entry.key,
    created_at: entry.created_at,
    expires_at: entry.expires_at,
    ...(typeof entry.exclusive_scope === "string" && entry.exclusive_scope.length > 0
      ? { exclusive_scope: entry.exclusive_scope }
      : {}),
  };
};

export class ConsoleApi {
  #csrfToken: string | undefined;
  readonly #ambiguousMutationKeys = new Map<string, PersistedMutationKey>();
  readonly #inFlightMutations = new Map<string, Promise<unknown>>();
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
      const entries = record.entries.map(persistedMutationKey);
      if (entries.length > MAX_AMBIGUOUS_MUTATIONS) {
        throw new MutationRetryStateError("CAPACITY_REACHED");
      }
      for (const entry of entries) {
        if (this.#ambiguousMutationKeys.has(entry.fingerprint)) {
          throw new Error("Mutation retry state contains a duplicate fingerprint.");
        }
        this.#ambiguousMutationKeys.set(entry.fingerprint, entry);
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

  #assertRetryStateAvailable(): void {
    if (this.#retryStateError) {
      throw this.#retryStateError;
    }
  }

  #reserveMutationKey(fingerprint: string, requestedKey?: string, exclusiveScope?: string): string {
    this.#assertRetryStateAvailable();
    const existing = this.#ambiguousMutationKeys.get(fingerprint);
    if (existing) {
      return existing.key;
    }
    if (
      exclusiveScope !== undefined &&
      [...this.#ambiguousMutationKeys.values()].some(
        (entry) => entry.exclusive_scope === exclusiveScope,
      )
    ) {
      throw new PendingResponseOutcomeUnknownError();
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
      ...(exclusiveScope === undefined ? {} : { exclusive_scope: exclusiveScope }),
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

  #reconcilePendingMutationKeys(
    sessionId: string,
    interactions: readonly WirePendingInteraction[],
  ): void {
    const prefix = `/api/v1/sessions/${encodeURIComponent(sessionId)}/pending/`;
    const states = new Map(
      interactions.map((interaction) => [interaction.requestId, interaction.state]),
    );
    const nextEntries = new Map(this.#ambiguousMutationKeys);
    for (const [fingerprint, entry] of nextEntries) {
      if (!entry.exclusive_scope?.startsWith(prefix)) {
        continue;
      }
      const encodedRequestId = entry.exclusive_scope.slice(prefix.length, -"/responses".length);
      const requestId = decodeURIComponent(encodedRequestId);
      if (states.get(requestId) !== "pending") {
        nextEntries.delete(fingerprint);
      }
    }
    if (nextEntries.size !== this.#ambiguousMutationKeys.size) {
      this.#persistMutationKeys(nextEntries);
      this.#ambiguousMutationKeys.clear();
      for (const [fingerprint, entry] of nextEntries) {
        this.#ambiguousMutationKeys.set(fingerprint, entry);
      }
    }
  }

  #pendingOutcomeUnknown(path: string): boolean {
    return [...this.#ambiguousMutationKeys.values()].some(
      (entry) => entry.exclusive_scope === path,
    );
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
    decode?: (body: unknown) => T,
    exclusiveScope?: string,
  ): Promise<T> {
    const serializedBody = JSON.stringify(body);
    const inFlightIdentity = `${method}\n${path}\n${serializedBody ?? ""}`;
    const inFlight = this.#inFlightMutations.get(inFlightIdentity);
    if (inFlight) {
      return (await inFlight) as T;
    }
    const mutation = mutationFingerprint(method, path, serializedBody).then(
      async (fingerprint) =>
        await this.#performMutation(
          path,
          serializedBody,
          method,
          fingerprint,
          key,
          allowCsrfRefresh,
          decode,
          exclusiveScope,
        ),
    );
    this.#inFlightMutations.set(inFlightIdentity, mutation);
    try {
      return await mutation;
    } finally {
      if (this.#inFlightMutations.get(inFlightIdentity) === mutation) {
        this.#inFlightMutations.delete(inFlightIdentity);
      }
    }
  }

  async #performMutation<T>(
    path: string,
    serializedBody: string | undefined,
    method: "DELETE" | "PATCH" | "POST" | "PUT",
    fingerprint: string,
    key: string | undefined,
    allowCsrfRefresh: boolean,
    decode: ((body: unknown) => T) | undefined,
    exclusiveScope: string | undefined,
  ): Promise<T> {
    const requestKey = this.#reserveMutationKey(fingerprint, key, exclusiveScope);
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
      return await this.#performMutation(
        path,
        serializedBody,
        method,
        fingerprint,
        requestKey,
        false,
        decode,
        exclusiveScope,
      );
    }
    try {
      const body = await json<unknown>(response);
      const result = decode ? decode(body) : (body as T);
      this.#releaseMutationKey(fingerprint, requestKey);
      return result;
    } catch (error) {
      if (
        error instanceof PendingResponseOutcomeUnknownError ||
        (error instanceof ApiError &&
          error.code === "PENDING_REQUEST_ANSWER_TIMEOUT" &&
          (error.details as { answerOutcome?: unknown } | undefined)?.answerOutcome === "unknown")
      ) {
        throw error instanceof PendingResponseOutcomeUnknownError
          ? error
          : new PendingResponseOutcomeUnknownError();
      }
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
        epoch: page.epoch,
        events: page.items
          .filter((item): item is WireTimelineEvent => item.kind !== "history_gap")
          .map(projectTimelineEvent),
        previousCursor: page.previousCursor,
        coverage: page.coverage,
        legacyImportPending: page.legacyImportPending === true ? true : undefined,
        gap: gap ? { reason: gap.reason, message: gap.message } : undefined,
        writeError: page.writeError,
      };
    });
  }

  pending(id: string): Promise<readonly PendingInteraction[]> {
    return this.get<{ readonly pending: readonly WirePendingInteraction[] }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/pending`,
    ).then(({ pending }) => {
      this.#reconcilePendingMutationKeys(id, pending);
      return pending.map((interaction) => {
        const path = pendingResponsePath(id, interaction.requestId);
        return pendingInteraction(interaction, this.#pendingOutcomeUnknown(path));
      });
    });
  }

  createSession(input: CreateSessionInput): Promise<SessionDetail> {
    const { permissionPolicy: policy, ...fields } = input;
    return this.mutate(
      "/api/v1/sessions",
      {
        ...fields,
        policy,
      },
      "POST",
      undefined,
      true,
      decodeSessionMutation(input),
    );
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

  /**
   * Discovery opens a provider session, so it must not ride the retrying
   * mutation helper: a transport retry would open another one. It carries the
   * CSRF token by hand and is sent exactly once.
   */
  async probeSessionOptions(
    agentId: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<SessionOptionsProbe> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      // Satisfies the mutation gate. Deliberately fresh every time and never
      // replayed: each probe is a new discovery, and reusing a key would either
      // return a stale catalog or, worse, invite a retry that opens a second
      // provider session.
      "Idempotency-Key": `probe-${crypto.randomUUID()}`,
    };
    if (this.#csrfToken) {
      headers["X-CSRF-Token"] = this.#csrfToken;
    }
    return await json<SessionOptionsProbe>(
      await fetch("/api/v1/agents/session-options", {
        method: "POST",
        headers,
        body: JSON.stringify({ agentId, cwd }),
        signal,
      }),
    );
  }

  workspaceSuggestions(prefix: string): Promise<readonly WorkspaceSuggestion[]> {
    const search = new URLSearchParams({ prefix });
    return this.get<{ readonly suggestions: readonly WorkspaceSuggestion[] }>(
      `/api/v1/workspaces/suggestions?${search}`,
    ).then((body) => body.suggestions);
  }

  /** Widens what this console can reach, so it is a mutation rather than a read. */
  authorizeWorkspace(path: string): Promise<string> {
    return this.mutate<{ readonly path: string }>(
      "/api/v1/workspaces/authorizations",
      { path },
      "POST",
    ).then((body) => body.path);
  }

  adoptSession(input: AdoptSessionInput): Promise<SessionDetail> {
    return this.mutate(
      "/api/v1/sessions/adopt",
      input,
      "POST",
      undefined,
      true,
      decodeSessionMutation(input),
    );
  }

  sendPrompt(sessionId: string, text: string): Promise<MutationReceipt> {
    return this.mutate(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
      { text },
      "POST",
      undefined,
      true,
      decodePromptMutation(sessionId),
    );
  }

  cancelTurn(sessionId: string, turnId: string): Promise<void> {
    return this.mutate(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
      {},
      "POST",
      undefined,
      true,
      decodeCancelMutation(turnId),
    );
  }

  closeSession(sessionId: string): Promise<CloseSessionResult> {
    return this.mutate(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/close`,
      {},
      "POST",
      undefined,
      true,
      decodeCloseMutation(sessionId),
    );
  }

  answerInteraction(sessionId: string, requestId: string, answer: unknown): Promise<void> {
    const path = pendingResponsePath(sessionId, requestId);
    return this.mutate(
      path,
      { response: answer },
      "POST",
      undefined,
      true,
      decodePendingMutation(sessionId, requestId),
      path,
    );
  }
}

const pendingResponsePath = (sessionId: string, requestId: string): string =>
  `/api/v1/sessions/${encodeURIComponent(sessionId)}/pending/${encodeURIComponent(requestId)}/responses`;

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
  readonly epoch: string | null;
  readonly items: readonly (WireTimelineEvent | WireTimelineGap)[];
  readonly previousCursor?: string;
  readonly hasMore: boolean;
  readonly coverage: "complete" | "legacy_retained" | "incomplete";
  readonly legacyImportPending?: true;
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

const mutationRecord = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} response is not an object.`);
  }
  return value as Record<string, unknown>;
};

const mutationString = (record: Record<string, unknown>, field: string, name: string): string => {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} response has an invalid ${field}.`);
  }
  return value;
};

const mutationTimestamp = (
  record: Record<string, unknown>,
  field: string,
  name: string,
): string => {
  const value = mutationString(record, field, name);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} response has an invalid ${field} timestamp.`);
  }
  return value;
};

const optionalMutationString = (
  record: Record<string, unknown>,
  field: string,
  name: string,
): void => {
  if (record[field] !== undefined && typeof record[field] !== "string") {
    throw new Error(`${name} response has an invalid ${field}.`);
  }
};

const mutationNonnegativeInteger = (
  record: Record<string, unknown>,
  field: string,
  name: string,
): number => {
  const value = record[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} response has an invalid ${field}.`);
  }
  return value as number;
};

const mutationEnum = <T extends string>(
  record: Record<string, unknown>,
  field: string,
  values: ReadonlySet<T>,
  name: string,
): T => {
  const value = mutationString(record, field, name);
  if (!values.has(value as T)) {
    throw new Error(`${name} response has an unsupported ${field}.`);
  }
  return value as T;
};

const SESSION_STATES = new Set<SessionSummary["sessionState"]>(["open", "closed"]);
const OWNER_STATES = new Set<SessionSummary["ownerState"]>([
  "absent",
  "starting",
  "online",
  "unreachable",
  "dead",
]);
const TURN_STATES = new Set<SessionSummary["turnState"]>([
  "idle",
  "queued",
  "starting",
  "running",
  "waiting_permission",
  "waiting_elicitation",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "unknown",
]);
const MODE_STATES = new Set<SessionDetail["modeState"]>([
  "unmanaged",
  "stored",
  "unverified",
  "conflict",
]);
const ADMISSION_STATES = new Set<WireMutationReceipt["admission"]>([
  "started",
  "queued",
  "unknown",
]);
const CANCEL_STATES = new Set(["cancelling", "cancelled", "completed", "unknown"] as const);
const PENDING_KINDS = new Set<WirePendingInteraction["kind"]>(["permission", "elicitation"]);
const TERMINAL_PENDING_STATES = new Set<PendingInteraction["state"]>([
  "answered",
  "cancelled",
  "expired",
  "orphaned",
]);

// oxlint-disable-next-line eslint/complexity -- Mutation success must validate the complete server-owned session shape before releasing its retry key.
const decodeWireSession = (value: unknown): WireSession => {
  const session = mutationRecord(value, "Session mutation");
  mutationString(session, "acpxRecordId", "Session mutation");
  mutationString(session, "agentId", "Session mutation");
  mutationString(session, "cwd", "Session mutation");
  mutationTimestamp(session, "updatedAt", "Session mutation");
  mutationEnum(session, "sessionState", SESSION_STATES, "Session mutation");
  mutationEnum(session, "ownerState", OWNER_STATES, "Session mutation");
  mutationEnum(session, "turnState", TURN_STATES, "Session mutation");
  if (session.modeState !== undefined) {
    mutationEnum(session, "modeState", MODE_STATES, "Session mutation");
  }
  if (session.pendingCount !== undefined) {
    mutationNonnegativeInteger(session, "pendingCount", "Session mutation");
  }
  for (const field of [
    "acpSessionId",
    "agentSessionId",
    "name",
    "title",
    "repo",
    "branch",
    "model",
    "mode",
    "desiredMode",
    "effectiveMode",
    "modeRemediation",
    "activeTurnId",
    "providerSessionId",
    "closeReason",
  ]) {
    optionalMutationString(session, field, "Session mutation");
  }
  if (session.createdAt !== undefined) {
    mutationTimestamp(session, "createdAt", "Session mutation");
  }
  const queue = mutationRecord(session.queue, "Session queue");
  const queueDepth = mutationNonnegativeInteger(queue, "depth", "Session queue");
  if (!Array.isArray(queue.turns)) {
    throw new Error("Session mutation response has invalid queued turns.");
  }
  const turnIds = new Set<string>();
  for (const value of queue.turns) {
    const turn = mutationRecord(value, "Session queued turn");
    const turnId = mutationString(turn, "turnId", "Session queued turn");
    mutationTimestamp(turn, "submittedAt", "Session queued turn");
    if (turn.promptText !== undefined && typeof turn.promptText !== "string") {
      throw new Error("Session mutation response has invalid queued prompt text.");
    }
    if (turnIds.has(turnId)) {
      throw new Error("Session mutation response has duplicate queued turn IDs.");
    }
    turnIds.add(turnId);
  }
  if (queueDepth < queue.turns.length) {
    throw new Error("Session mutation response has an inconsistent queue depth.");
  }
  return session as unknown as WireSession;
};

const decodeSessionMutation =
  (input: { readonly agentId: string }): ((value: unknown) => SessionDetail) =>
  (value) => {
    const response = mutationRecord(value, "Session mutation");
    const session = decodeWireSession(response.session);
    if (session.agentId !== input.agentId) {
      throw new Error("Session mutation response has the wrong agent identity.");
    }
    return sessionDetail(session);
  };

const decodePromptMutation =
  (sessionId: string): ((value: unknown) => MutationReceipt) =>
  (value) => {
    const receipt = mutationRecord(value, "Prompt mutation");
    return {
      accepted: true,
      sessionId,
      turnId: mutationString(receipt, "turnId", "Prompt mutation"),
      state: mutationEnum(receipt, "admission", ADMISSION_STATES, "Prompt mutation"),
    };
  };

const decodeCancelMutation =
  (turnId: string): ((value: unknown) => void) =>
  (value) => {
    const receipt = mutationRecord(value, "Cancel mutation");
    if (mutationString(receipt, "turnId", "Cancel mutation") !== turnId) {
      throw new Error("Cancel mutation response has the wrong turnId.");
    }
    mutationEnum(receipt, "state", CANCEL_STATES, "Cancel mutation");
  };

const decodeProviderClose = (value: unknown): CloseSessionResult["providerClose"] => {
  const providerClose = mutationRecord(value, "Close mutation provider result");
  const status = mutationEnum(
    providerClose,
    "status",
    new Set(["confirmed", "degraded"] as const),
    "Close mutation provider result",
  );
  if (status === "confirmed") {
    return { status };
  }
  return {
    status,
    reason: mutationEnum(
      providerClose,
      "reason",
      new Set(["owner_absent", "unsupported", "provider_error"] as const),
      "Close mutation provider result",
    ),
  };
};

const decodeCloseMutation =
  (sessionId: string): ((value: unknown) => CloseSessionResult) =>
  (value) => {
    const response = mutationRecord(value, "Close mutation");
    const close = mutationRecord(response.close, "Close mutation");
    if (close.localClose !== "closed") {
      throw new Error("Close mutation response has an invalid localClose.");
    }
    const session = decodeWireSession(close.session);
    if (session.acpxRecordId !== sessionId) {
      throw new Error("Close mutation response has the wrong session identity.");
    }
    return {
      session: sessionDetail(session),
      localClose: "closed",
      providerClose: decodeProviderClose(close.providerClose),
    };
  };

const decodePendingMutation =
  (sessionId: string, requestId: string): ((value: unknown) => void) =>
  (value) => {
    const response = mutationRecord(value, "Pending response mutation");
    const pending = mutationRecord(response.pending, "Pending response mutation");
    if (
      mutationString(pending, "acpxRecordId", "Pending response mutation") !== sessionId ||
      mutationString(pending, "requestId", "Pending response mutation") !== requestId
    ) {
      throw new Error("Pending response mutation returned the wrong request identity.");
    }
    mutationTimestamp(pending, "createdAt", "Pending response mutation");
    mutationEnum(pending, "kind", PENDING_KINDS, "Pending response mutation");
    if (pending.state === "pending" && response.outcome === "unknown") {
      throw new PendingResponseOutcomeUnknownError();
    }
    mutationEnum(pending, "state", TERMINAL_PENDING_STATES, "Pending response mutation");
  };

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
  model: session.model,
  mode: session.mode,
  desiredMode: session.desiredMode,
  effectiveMode: session.effectiveMode,
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
  modeState: session.modeState ?? "unmanaged",
  modeRemediation: session.modeRemediation,
  permissionPolicy: session.permissionPolicy,
  closeReason: session.closeReason,
});

const payloadRecord = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};

const pendingInteraction = (
  interaction: WirePendingInteraction,
  responseOutcomeUnknown = false,
): PendingInteraction => {
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
    ...(responseOutcomeUnknown && interaction.state === "pending"
      ? { responseOutcome: "unknown" as const }
      : {}),
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
