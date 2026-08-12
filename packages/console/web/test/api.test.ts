import assert from "node:assert/strict";
import test from "node:test";
import { ConsoleApi } from "../src/api";

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
  queue: { depth: 2 },
  pendingCount: 1,
  updatedAt: "2026-08-12T10:00:00.000Z",
};

test("unwraps session and pending routes while preserving exact record identity", async () => {
  const client = new ConsoleApi();
  await withFetch(
    async (input) => {
      const url = String(input);
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
      const session = await client.session("record-1");
      assert.equal(session.id, "record-1");
      assert.equal(session.queuedCount, 2);
      const pending = await client.pending("record-1");
      assert.deepEqual(pending[0]?.options, [{ id: "allow", label: "Allow", kind: "allow_once" }]);
    },
  );
});

test("projects the core item timeline and explicit legacy gap", async () => {
  const client = new ConsoleApi();
  await withFetch(
    async () =>
      response({
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
      }),
    async () => {
      const page = await client.timeline("record-1");
      assert.equal(page.previousCursor, "cursor-1");
      assert.equal(page.gap?.reason, "Earlier history retained elsewhere.");
      assert.deepEqual(page.events[0], {
        id: "event:7",
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

test("sends CSRF, idempotency, wrapped interaction answers, and adoption cwd", async () => {
  const client = new ConsoleApi();
  client.setCsrfToken("csrf-1");
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  await withFetch(
    async (input, init) => {
      requests.push({ url: String(input), init });
      if (String(input).includes("/agents/")) {
        return response({ sessions: [] });
      }
      return response({ pending: {} });
    },
    async () => {
      await client.providerSessions("codex", "/work/checkout");
      await client.answerInteraction("record-1", "request-1", { type: "cancel" });
    },
  );
  assert.match(requests[0]!.url, /cwd=%2Fwork%2Fcheckout/u);
  const headers = requests[1]!.init?.headers as Record<string, string>;
  assert.equal(headers["X-CSRF-Token"], "csrf-1");
  assert.ok(headers["Idempotency-Key"]);
  assert.deepEqual(JSON.parse(String(requests[1]!.init?.body)), { response: { type: "cancel" } });
});
