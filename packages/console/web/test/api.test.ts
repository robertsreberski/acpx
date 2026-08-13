import assert from "node:assert/strict";
import test from "node:test";
import {
  ConsoleApi,
  MutationRetryStateError,
  MutationTransportUnknownError,
  PendingResponseOutcomeUnknownError,
} from "../src/api";

class MemoryStorage {
  readonly #items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }

  values(): readonly string[] {
    return [...this.#items.values()];
  }
}

const client = (storage = new MemoryStorage(), now?: () => number): ConsoleApi =>
  new ConsoleApi({ storage, now });

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const withFetch = async (
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> => {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
};

const SESSION = {
  acpxRecordId: "record-1",
  agentId: "codex",
  name: "Checkout fix",
  cwd: "/work/checkout",
  sessionState: "open",
  ownerState: "online",
  turnState: "running",
  queue: {
    depth: 2,
    turns: [
      {
        turnId: "turn-queued",
        submittedAt: "2026-08-12T09:59:00.000Z",
        promptText: "Run the focused tests",
      },
    ],
  },
  pendingCount: 1,
  updatedAt: "2026-08-12T10:00:00.000Z",
};

const ANSWERED_PENDING = {
  requestId: "request-1",
  acpxRecordId: "record-1",
  kind: "permission",
  state: "answered",
  createdAt: "2026-08-12T10:01:00.000Z",
};

const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

test("unwraps session and pending routes while preserving exact record identity", async () => {
  const api = client();
  await withFetch(
    async (input) => {
      const url = requestUrl(input);
      return url.endsWith("/pending")
        ? response({
            pending: [
              {
                requestId: "request-1",
                acpxRecordId: "record-1",
                kind: "permission",
                state: "pending",
                createdAt: "2026-08-12T10:01:00.000Z",
                options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
              },
            ],
          })
        : response({ session: SESSION });
    },
    async () => {
      const session = await api.session("record-1");
      assert.equal(session.id, "record-1");
      assert.equal(session.queuedCount, 2);
      assert.deepEqual(session.queuedTurns, [
        {
          id: "turn-queued",
          submittedAt: "2026-08-12T09:59:00.000Z",
          text: "Run the focused tests",
        },
      ]);
      const pending = await api.pending("record-1");
      assert.deepEqual(pending[0]?.options, [{ id: "allow", label: "Allow", kind: "allow_once" }]);
    },
  );
});

test("preserves a degraded provider-close result instead of reporting full success", async () => {
  const api = client();
  await withFetch(
    async () =>
      response({
        close: {
          session: { ...SESSION, sessionState: "closed" },
          localClose: "closed",
          providerClose: { status: "degraded", reason: "provider_error" },
        },
      }),
    async () => {
      const closed = await api.closeSession("record-1");
      assert.equal(closed.session.id, "record-1");
      assert.equal(closed.session.sessionState, "closed");
      assert.deepEqual(closed.providerClose, {
        status: "degraded",
        reason: "provider_error",
      });
    },
  );
});

test("projects the core item timeline and explicit legacy gap", async () => {
  const api = client();
  await withFetch(
    async () =>
      response({
        epoch: "epoch-1",
        items: [
          {
            schema: "acpx.session_history_gap.v1",
            kind: "history_gap",
            reason: "legacy_retained",
            message: "Earlier history retained elsewhere.",
          },
          {
            schema: "acpx.session_event.v1",
            acpx_record_id: "record-1",
            epoch: "epoch-1",
            seq: 7,
            captured_at: "2026-08-12T10:00:00.000Z",
            direction: "outbound",
            turn_id: "turn-1",
            payload: {
              kind: "acp",
              message: { jsonrpc: "2.0", method: "session/prompt", params: { text: "Fix it" } },
            },
          },
        ],
        previousCursor: "cursor-1",
        hasMore: true,
        coverage: "legacy_retained",
        legacyImportPending: true,
      }),
    async () => {
      const page = await api.timeline("record-1");
      assert.equal(page.epoch, "epoch-1");
      assert.equal(page.previousCursor, "cursor-1");
      assert.equal(page.legacyImportPending, true);
      assert.deepEqual(page.gap, {
        reason: "legacy_retained",
        message: "Earlier history retained elsewhere.",
      });
      assert.deepEqual(page.events[0], {
        id: "event:epoch-1:7",
        epoch: "epoch-1",
        sequence: 7,
        occurredAt: "2026-08-12T10:00:00.000Z",
        direction: "client_to_agent",
        turnId: "turn-1",
        requestId: undefined,
        kind: "message",
        role: "user",
        text: "Fix it",
        status: "complete",
        payload: {
          kind: "acp",
          message: { jsonrpc: "2.0", method: "session/prompt", params: { text: "Fix it" } },
        },
      });
    },
  );
});

test("projects corrupt timeline coverage without claiming complete history", async () => {
  const api = client();
  await withFetch(
    async () =>
      response({
        epoch: "epoch-corrupt",
        items: [
          {
            schema: "acpx.session_history_gap.v1",
            kind: "history_gap",
            reason: "corrupt",
            message: "A corrupt timeline epoch was isolated.",
          },
        ],
        hasMore: false,
        coverage: "incomplete",
      }),
    async () => {
      const page = await api.timeline("record-1");
      assert.equal(page.epoch, "epoch-corrupt");
      assert.equal(page.coverage, "incomplete");
      assert.deepEqual(page.gap, {
        reason: "corrupt",
        message: "A corrupt timeline epoch was isolated.",
      });
    },
  );
});

test("only a literal true enables legacy transcript continuation", async () => {
  const api = client();
  for (const [raw, expected] of [
    [true, true],
    [false, undefined],
    ["true", undefined],
    [1, undefined],
  ] as const) {
    await withFetch(
      async () =>
        response({
          epoch: "epoch-legacy",
          items: [],
          hasMore: false,
          coverage: "legacy_retained",
          legacyImportPending: raw,
        }),
      async () => {
        assert.equal((await api.timeline("record-1")).legacyImportPending, expected);
      },
    );
  }
});

test("sends CSRF, idempotency, wrapped interaction answers, and adoption cwd", async () => {
  const api = client();
  api.setCsrfToken("csrf-1");
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  await withFetch(
    async (input, init) => {
      requests.push({ url: requestUrl(input), init });
      if (requestUrl(input).includes("/agents/")) {
        return response({ sessions: [] });
      }
      return response({ pending: ANSWERED_PENDING });
    },
    async () => {
      await api.providerSessions("codex", "/work/checkout");
      await api.answerInteraction("record-1", "request-1", { type: "cancel" });
    },
  );
  assert.match(requests[0].url, /cwd=%2Fwork%2Fcheckout/u);
  const headers = new Headers(requests[1].init?.headers);
  assert.equal(headers.get("X-CSRF-Token"), "csrf-1");
  assert.ok(headers.get("Idempotency-Key"));
  const body = requests[1].init?.body;
  assert.equal(typeof body, "string");
  assert.deepEqual(JSON.parse(body), { response: { type: "cancel" } });
});

test("sends an explicit custom-agent mode for both session creation paths", async () => {
  const api = client();
  const bodies: unknown[] = [];
  await withFetch(
    async (_input, init) => {
      assert.equal(typeof init?.body, "string");
      bodies.push(JSON.parse(init.body as string));
      return response({ session: { ...SESSION, agentId: "mock", mode: "review" } });
    },
    async () => {
      await api.createSession({
        agentId: "mock",
        cwd: "/work/checkout",
        mode: "review",
        permissionPolicy: "defer-risky",
      });
      await api.adoptSession({
        agentId: "mock",
        providerSessionId: "provider-mock",
        cwd: "/work/checkout",
        mode: "review",
      });
    },
  );
  assert.deepEqual(bodies, [
    {
      agentId: "mock",
      cwd: "/work/checkout",
      mode: "review",
      policy: "defer-risky",
    },
    {
      agentId: "mock",
      providerSessionId: "provider-mock",
      cwd: "/work/checkout",
      mode: "review",
    },
  ]);
});

test("accepts the legacy-compatible optional session mutation fields", async () => {
  const legacySession = {
    acpxRecordId: "record-legacy",
    agentId: "codex",
    cwd: "/work/checkout",
    sessionState: "open",
    ownerState: "absent",
    turnState: "idle",
    queue: { depth: 0, turns: [] },
    updatedAt: "2026-08-12T10:00:00.000Z",
  };
  await withFetch(
    async () => response({ session: legacySession }, 201),
    async () => {
      const created = await client().createSession({
        agentId: "codex",
        cwd: "/work/checkout",
        permissionPolicy: "defer-risky",
      });
      assert.equal(created.id, "record-legacy");
      assert.equal(created.createdAt, legacySession.updatedAt);
      assert.equal(created.modeState, "unmanaged");
      assert.equal(created.pendingCount, 0);
    },
  );
});

test("a network retry reuses the same idempotency key", async () => {
  const api = client();
  const keys: string[] = [];
  let attempts = 0;
  await withFetch(
    async (_input, init) => {
      attempts += 1;
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (attempts === 1) {
        throw new TypeError("network disconnected");
      }
      return response({ pending: ANSWERED_PENDING });
    },
    async () => {
      await api.answerInteraction("record-1", "request-1", { type: "cancel" });
    },
  );
  assert.equal(attempts, 2);
  assert.ok(keys[0]);
  assert.equal(keys[1], keys[0]);
});

test("an explicit retry after two lost responses retains the original idempotency key", async () => {
  const api = client();
  const keys: string[] = [];
  let attempts = 0;
  await withFetch(
    async (_input, init) => {
      attempts += 1;
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (attempts <= 2) {
        throw new TypeError("response lost");
      }
      return response({ turnId: "turn-1", admission: "started" });
    },
    async () => {
      await assert.rejects(
        async () => await api.sendPrompt("record-1", "hello"),
        MutationTransportUnknownError,
      );
      assert.deepEqual(await api.sendPrompt("record-1", "hello"), {
        accepted: true,
        sessionId: "record-1",
        turnId: "turn-1",
        state: "started",
      });
    },
  );
  assert.equal(attempts, 3);
  assert.ok(keys[0]);
  assert.deepEqual(keys, [keys[0], keys[0], keys[0]]);
});

test("an unknown pending response blocks conflicting answers until durable reconciliation", async () => {
  const api = client();
  const mutations: Array<{ key: string; body: string }> = [];
  let pendingReads = 0;
  await withFetch(
    async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/pending")) {
        pendingReads += 1;
        return response({
          pending: [
            {
              ...ANSWERED_PENDING,
              state: pendingReads === 1 ? "pending" : "answered",
            },
          ],
        });
      }
      mutations.push({
        key: new Headers(init?.headers).get("Idempotency-Key") ?? "",
        body: String(init?.body),
      });
      return mutations.length === 1
        ? response(
            {
              error: {
                code: "PENDING_REQUEST_ANSWER_TIMEOUT",
                message: "Request answer outcome is unknown; it may still be applied",
                details: { answerOutcome: "unknown" },
              },
            },
            504,
          )
        : response({ pending: ANSWERED_PENDING, outcome: "confirmed" });
    },
    async () => {
      await assert.rejects(
        async () => await api.answerInteraction("record-1", "request-1", { type: "cancel" }),
        PendingResponseOutcomeUnknownError,
      );
      await assert.rejects(
        async () => await api.answerInteraction("record-1", "request-1", { type: "decline" }),
        PendingResponseOutcomeUnknownError,
      );
      assert.equal(mutations.length, 1, "a conflicting answer reached the server");

      const pending = await api.pending("record-1");
      assert.equal(pending[0]?.responseOutcome, "unknown");
      await assert.rejects(
        async () => await api.answerInteraction("record-1", "request-1", { type: "decline" }),
        PendingResponseOutcomeUnknownError,
      );
      assert.equal(mutations.length, 1, "a conflict bypassed the persisted ambiguity lock");

      const settled = await api.pending("record-1");
      assert.equal(settled[0]?.responseOutcome, undefined);
      await api.answerInteraction("record-1", "request-1", { type: "decline" });
    },
  );
  assert.equal(mutations.length, 2);
  assert.notEqual(mutations[1]?.key, mutations[0]?.key);
});

test("an accepted-but-unconfirmed response reuses its key until confirmation", async () => {
  const api = client();
  const keys: string[] = [];
  await withFetch(
    async (_input, init) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      return keys.length === 1
        ? response(
            {
              pending: { ...ANSWERED_PENDING, state: "pending" },
              outcome: "unknown",
            },
            202,
          )
        : response({ pending: ANSWERED_PENDING, outcome: "confirmed" });
    },
    async () => {
      await assert.rejects(
        async () => await api.answerInteraction("record-1", "request-1", { type: "cancel" }),
        PendingResponseOutcomeUnknownError,
      );
      await api.answerInteraction("record-1", "request-1", { type: "cancel" });
    },
  );
  assert.equal(keys.length, 2);
  assert.ok(keys[0]);
  assert.equal(keys[1], keys[0]);
});

test("a malformed successful response retains the mutation idempotency key", async () => {
  const api = client();
  const keys: string[] = [];
  let attempts = 0;
  await withFetch(
    async (_input, init) => {
      attempts += 1;
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      return attempts === 1
        ? new Response('{"turnId":', {
            status: 202,
            headers: { "Content-Type": "application/json" },
          })
        : response({ turnId: "turn-1", admission: "started" }, 202);
    },
    async () => {
      await assert.rejects(
        async () => await api.sendPrompt("record-1", "malformed response"),
        MutationTransportUnknownError,
      );
      await api.sendPrompt("record-1", "malformed response");
    },
  );
  assert.equal(attempts, 2);
  assert.ok(keys[0]);
  assert.equal(keys[1], keys[0]);
});

test("semantically invalid successful mutation responses retain each action key", async () => {
  const actions: ReadonlyArray<{
    readonly name: string;
    readonly run: (api: ConsoleApi) => Promise<unknown>;
  }> = [
    {
      name: "create",
      run: async (api) =>
        await api.createSession({
          agentId: "codex",
          cwd: "/work/checkout",
          permissionPolicy: "defer-risky",
        }),
    },
    {
      name: "adopt",
      run: async (api) =>
        await api.adoptSession({
          agentId: "codex",
          providerSessionId: "provider-1",
          cwd: "/work/checkout",
        }),
    },
    { name: "prompt", run: async (api) => await api.sendPrompt("record-1", "hello") },
    { name: "cancel", run: async (api) => await api.cancelTurn("record-1", "turn-1") },
    { name: "close", run: async (api) => await api.closeSession("record-1") },
    {
      name: "answer",
      run: async (api) => await api.answerInteraction("record-1", "request-1", { type: "cancel" }),
    },
  ];

  for (const action of actions) {
    const api = client();
    const keys: string[] = [];
    await withFetch(
      async (_input, init) => {
        keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        return response({});
      },
      async () => {
        await assert.rejects(action.run(api), MutationTransportUnknownError, action.name);
        await assert.rejects(action.run(api), MutationTransportUnknownError, action.name);
      },
    );
    assert.equal(keys.length, 2, action.name);
    assert.ok(keys[0], action.name);
    assert.equal(keys[1], keys[0], action.name);
  }
});

test("concurrent identical mutations cannot split into success and unknown outcomes", async () => {
  const api = client();
  let requests = 0;
  let markDispatched: (() => void) | undefined;
  let finishRequest: ((value: Response) => void) | undefined;
  const dispatched = new Promise<void>((resolve) => {
    markDispatched = resolve;
  });
  const responseGate = new Promise<Response>((resolve) => {
    finishRequest = resolve;
  });

  await withFetch(
    async () => {
      requests += 1;
      markDispatched?.();
      if (requests > 1) {
        throw new TypeError("a concurrent duplicate would have an unknown outcome");
      }
      return await responseGate;
    },
    async () => {
      const first = api.sendPrompt("record-1", "same action");
      const second = api.sendPrompt("record-1", "same action");
      await dispatched;
      finishRequest?.(response({ turnId: "turn-shared", admission: "started" }, 202));
      assert.deepEqual(await Promise.all([first, second]), [
        {
          accepted: true,
          sessionId: "record-1",
          turnId: "turn-shared",
          state: "started",
        },
        {
          accepted: true,
          sessionId: "record-1",
          turnId: "turn-shared",
          state: "started",
        },
      ]);
    },
  );
  assert.equal(requests, 1);
});

test("an ambiguous mutation keeps its exact key across a page reload", async () => {
  const storage = new MemoryStorage();
  const keys: string[] = [];
  let attempts = 0;
  await withFetch(
    async (_input, init) => {
      attempts += 1;
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (attempts <= 2) {
        throw new TypeError("response lost");
      }
      return response({ turnId: "turn-reloaded", admission: "started" }, 202);
    },
    async () => {
      await assert.rejects(
        async () => await client(storage).sendPrompt("record-1", "sensitive prompt body"),
        MutationTransportUnknownError,
      );
      await client(storage).sendPrompt("record-1", "sensitive prompt body");
    },
  );
  assert.equal(attempts, 3);
  assert.deepEqual(keys, [keys[0], keys[0], keys[0]]);
  assert.equal(storage.values().length, 0);
});

test("an aborted mutation keeps its exact key across a page reload", async () => {
  const storage = new MemoryStorage();
  const keys: string[] = [];
  let attempts = 0;
  await withFetch(
    async (_input, init) => {
      attempts += 1;
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (attempts === 1) {
        throw new DOMException("response stream aborted", "AbortError");
      }
      return response({ turnId: "turn-after-abort", admission: "started" }, 202);
    },
    async () => {
      await assert.rejects(
        async () => await client(storage).sendPrompt("record-1", "aborted response"),
        MutationTransportUnknownError,
      );
      await client(storage).sendPrompt("record-1", "aborted response");
    },
  );
  assert.equal(attempts, 2);
  assert.ok(keys[0]);
  assert.equal(keys[1], keys[0]);
  assert.equal(storage.values().length, 0);
});

test("the durable retry ledger stores only fingerprints, keys, and timestamps", async () => {
  const storage = new MemoryStorage();
  await withFetch(
    async () => {
      throw new TypeError("response lost");
    },
    async () => {
      await assert.rejects(
        async () => await client(storage).sendPrompt("record-1", "super-secret-prompt"),
        MutationTransportUnknownError,
      );
    },
  );
  const serialized = storage.values()[0];
  assert.ok(serialized);
  assert.equal(serialized.includes("super-secret-prompt"), false);
  const state = JSON.parse(serialized) as {
    readonly entries: readonly Record<string, unknown>[];
  };
  assert.deepEqual(Object.keys(state.entries[0] ?? {}).toSorted(), [
    "created_at",
    "expires_at",
    "fingerprint",
    "key",
  ]);
});

test("a full retry ledger fails closed without dispatching or evicting", async () => {
  const storage = new MemoryStorage();
  const api = client(storage);
  let requests = 0;
  const keys: string[] = [];
  await withFetch(
    async (_input, init) => {
      requests += 1;
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      throw new TypeError("response lost");
    },
    async () => {
      for (let index = 0; index < 64; index += 1) {
        await assert.rejects(
          async () => await api.sendPrompt("record-1", `ambiguous-${index}`),
          MutationTransportUnknownError,
        );
      }
      const persistedBefore = storage.values()[0];
      const requestsBefore = requests;
      await assert.rejects(
        async () => await api.sendPrompt("record-1", "must-not-dispatch"),
        (error: unknown) =>
          error instanceof MutationRetryStateError && error.code === "CAPACITY_REACHED",
      );
      assert.equal(requests, requestsBefore);
      assert.equal(storage.values()[0], persistedBefore);
      await assert.rejects(
        async () => await api.sendPrompt("record-1", "ambiguous-0"),
        MutationTransportUnknownError,
      );
      assert.equal(keys.at(-1), keys[0]);
      assert.equal(storage.values()[0], persistedBefore);
    },
  );
  assert.equal(requests, 130);
});

test("aged retry keys remain exact and are never silently expired", async () => {
  const storage = new MemoryStorage();
  let now = 1_000;
  const keys: string[] = [];
  let requests = 0;
  await withFetch(
    async (_input, init) => {
      requests += 1;
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (requests <= 2) {
        throw new TypeError("response lost");
      }
      return response({ turnId: "turn-aged", admission: "started" }, 202);
    },
    async () => {
      await assert.rejects(
        async () => await client(storage, () => now).sendPrompt("record-1", "expires"),
        MutationTransportUnknownError,
      );
      const serialized = storage.values()[0];
      assert.ok(serialized);
      const state = JSON.parse(serialized) as {
        readonly entries: readonly { readonly expires_at: number }[];
      };
      now = state.entries[0]?.expires_at ?? Number.MAX_SAFE_INTEGER;
      await client(storage, () => now).sendPrompt("record-1", "expires");
      assert.deepEqual(keys, [keys[0], keys[0], keys[0]]);
      assert.equal(storage.values().length, 0);
    },
  );
  assert.equal(requests, 3);
});

test("unavailable session storage blocks mutations before dispatch", async () => {
  const api = new ConsoleApi({ storage: null });
  let requests = 0;
  await withFetch(
    async () => {
      requests += 1;
      return response({ turnId: "unsafe", admission: "started" }, 202);
    },
    async () => {
      await assert.rejects(
        async () => await api.sendPrompt("record-1", "must-not-dispatch"),
        (error: unknown) =>
          error instanceof MutationRetryStateError && error.code === "STORAGE_UNAVAILABLE",
      );
    },
  );
  assert.equal(requests, 0);
});

test("changing an ambiguously completed mutation creates a distinct action identity", async () => {
  const api = client();
  const keys: string[] = [];
  let attempts = 0;
  await withFetch(
    async (_input, init) => {
      attempts += 1;
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (attempts <= 2) {
        throw new TypeError("response lost");
      }
      return response({ turnId: "turn-2", admission: "started" });
    },
    async () => {
      await assert.rejects(
        async () => await api.sendPrompt("record-1", "first"),
        MutationTransportUnknownError,
      );
      await api.sendPrompt("record-1", "second");
    },
  );
  assert.equal(attempts, 3);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[2], keys[0]);
});

test("an HTTP failure is not retried", async () => {
  const api = client();
  let attempts = 0;
  await assert.rejects(
    async () =>
      await withFetch(
        async () => {
          attempts += 1;
          return response({ error: { code: "TURN_CONFLICT", message: "Turn is busy" } }, 409);
        },
        async () => {
          await api.sendPrompt("record-1", "hello");
        },
      ),
    (error: unknown) => error instanceof Error && error.message === "Turn is busy",
  );
  assert.equal(attempts, 1);
});

test("a stale CSRF 403 refreshes bootstrap once and preserves idempotency", async () => {
  const api = client();
  api.setCsrfToken("csrf-old");
  const mutations: Headers[] = [];
  await withFetch(
    async (input, init) => {
      if (requestUrl(input).endsWith("/bootstrap")) {
        return response({
          version: 1,
          csrfToken: "csrf-new",
          agents: [],
          sessions: [],
          workspaceRoots: [],
          server: { networkTrusted: false },
        });
      }
      mutations.push(new Headers(init?.headers));
      return mutations.length === 1
        ? response({ error: { message: "stale CSRF" } }, 403)
        : response({ pending: ANSWERED_PENDING });
    },
    async () => {
      await api.answerInteraction("record-1", "request-1", { type: "cancel" });
    },
  );
  assert.equal(mutations.length, 2);
  assert.equal(mutations[0]?.get("X-CSRF-Token"), "csrf-old");
  assert.equal(mutations[1]?.get("X-CSRF-Token"), "csrf-new");
  assert.equal(mutations[1]?.get("Idempotency-Key"), mutations[0]?.get("Idempotency-Key"));
});

test("preserves an unknown prompt admission for reconciliation", async () => {
  const api = client();
  await withFetch(
    async () => response({ turnId: "turn-unknown", admission: "unknown" }),
    async () => {
      const receipt = await api.sendPrompt("record-1", "hello");
      assert.deepEqual(receipt, {
        accepted: true,
        sessionId: "record-1",
        turnId: "turn-unknown",
        state: "unknown",
      });
    },
  );
});

test("targets cancellation to the exact queued turn receipt", async () => {
  const api = client();
  let captured: { url: string; init?: RequestInit } | undefined;
  await withFetch(
    async (input, init) => {
      captured = { url: requestUrl(input), init };
      return response({ turnId: "turn/queued", state: "cancelled" }, 202);
    },
    async () => {
      await api.cancelTurn("record/one", "turn/queued");
    },
  );
  assert.equal(captured?.url, "/api/v1/sessions/record%2Fone/turns/turn%2Fqueued/cancel");
  assert.equal(captured?.init?.method, "POST");
  assert.equal(captured?.init?.body, "{}");
  assert.ok(new Headers(captured?.init?.headers).get("Idempotency-Key"));
});
