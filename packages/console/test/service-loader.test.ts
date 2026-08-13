import assert from "node:assert/strict";
import test from "node:test";
import type { ServiceInvalidation, TimelinePage } from "../src/contracts.js";
import { adaptAcpxSessionService } from "../src/service-loader.js";

function coreFixture(sessionList: "supported" | "unsupported" | "unknown" = "supported") {
  const calls: Array<{ method: string; input: unknown }> = [];
  const session = {
    acpxRecordId: "record-1",
    acpSessionId: "provider-1",
    agentId: "codex",
    cwd: "/workspace",
    sessionState: "open" as const,
    ownerState: "online" as const,
    turnState: "idle" as const,
    queue: { depth: 0, turns: [] },
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    pendingCount: 0,
  };
  const receipt = <T>(result: T) => ({
    operation: "test",
    idempotencyKey: "test-key",
    replayed: false,
    result,
  });
  return {
    calls,
    core: {
      async listAgents() {
        return [
          {
            agentId: "codex",
            label: "Codex",
            capabilities: {
              sessionList,
              sessionResume: "supported" as const,
              sessionLoad: "unknown" as const,
            },
          },
        ];
      },
      async listSessions() {
        return [session];
      },
      async getSession() {
        return session;
      },
      async listProviderSessions() {
        return { sessions: [{ providerSessionId: "native-1", title: "Native" }] };
      },
      async createSession(input: unknown) {
        calls.push({ method: "createSession", input });
        return receipt(session);
      },
      async adoptSession(input: unknown) {
        calls.push({ method: "adoptSession", input });
        return receipt(session);
      },
      async enqueuePrompt(input: unknown) {
        calls.push({ method: "enqueuePrompt", input });
        return receipt({ turnId: "turn-1", admission: "started" as const });
      },
      async cancelTurn(input: { turnId: string }) {
        return receipt({ turnId: input.turnId, state: "cancelling" as const });
      },
      async closeSession() {
        return receipt({
          session,
          localClose: "closed" as const,
          providerClose: { status: "confirmed" as const },
        });
      },
      async listPendingRequests() {
        return [];
      },
      async respondToPendingRequest(input: unknown) {
        calls.push({ method: "respondToPendingRequest", input });
        return receipt({
          requestId: "request-1",
          acpxRecordId: "record-1",
          kind: "permission" as const,
          state: "answered" as const,
          createdAt: "2026-08-12T00:00:00.000Z",
        });
      },
      async getTranscriptPage(): Promise<TimelinePage> {
        return {
          epoch: "epoch-1",
          items: [],
          hasMore: false,
          coverage: "complete",
          legacyImportPending: true,
          writeError: "EACCES /Users/operator/private/session.ndjson",
        };
      },
      subscribe(_listener: (event: ServiceInvalidation) => void) {
        return () => {};
      },
      dispose() {},
    },
  };
}

test("adapter unwraps mutation receipts and projects provider and agent inventory", async () => {
  const fixture = coreFixture();
  const service = adaptAcpxSessionService(fixture.core);
  assert.deepEqual(await service.listAgents({ cwd: "/workspace" }), [
    {
      agentId: "codex",
      label: "Codex",
      supportsSessionList: true,
    },
  ]);
  assert.deepEqual(
    (await service.listProviderSessions({ agentId: "codex", cwd: "/workspace" })).sessions,
    [{ providerSessionId: "native-1", title: "Native", cwd: undefined, updatedAt: undefined }],
  );
  const timeline = await service.getTranscriptPage({ acpxRecordId: "record-1" });
  assert.equal(timeline.epoch, "epoch-1");
  assert.equal(timeline.legacyImportPending, true);
  assert.equal(
    timeline.writeError,
    "Authoritative timeline persistence failed; recent history may be incomplete.",
  );
  const created = await service.createSession({
    agentId: "codex",
    cwd: "/workspace",
    policy: "defer-risky",
    idempotencyKey: "create-key",
  });
  assert.equal(created.acpxRecordId, "record-1");
  assert.deepEqual(fixture.calls.at(-1), {
    method: "createSession",
    input: {
      agentId: "codex",
      cwd: "/workspace",
      name: undefined,
      mode: "read-only",
      model: undefined,
      permissionPolicy: {
        autoApprove: ["read", "search"],
        defer: ["edit", "execute", "switch_mode"],
        defaultAction: "defer",
      },
      idempotencyKey: "create-key",
    },
  });
  const retained = await fixture.core.getSession();
  assert.deepEqual(
    await service.closeSession({ acpxRecordId: "record-1", idempotencyKey: "close-key" }),
    {
      session: retained,
      localClose: "closed",
      providerClose: { status: "confirmed" },
    },
  );
});

test("agent inventory preserves supported, unsupported, and unknown session-list capability", async () => {
  const cases = [
    ["supported", true],
    ["unsupported", false],
    ["unknown", undefined],
  ] as const;

  for (const [sessionList, supportsSessionList] of cases) {
    const fixture = coreFixture(sessionList);
    const service = adaptAcpxSessionService(fixture.core);
    assert.deepEqual(await service.listAgents({ cwd: "/workspace" }), [
      {
        agentId: "codex",
        label: "Codex",
        supportsSessionList,
      },
    ]);
  }
});

test("adapter translates web prompt and pending answer shapes into the stable core contract", async () => {
  const fixture = coreFixture();
  const service = adaptAcpxSessionService(fixture.core);
  assert.deepEqual(
    await service.enqueuePrompt({
      acpxRecordId: "record-1",
      text: "hello",
      idempotencyKey: "prompt-key",
    }),
    { turnId: "turn-1", admission: "started" },
  );
  await service.respondToPendingRequest({
    acpxRecordId: "record-1",
    requestId: "request-1",
    response: { type: "select", option_id: "allow" },
    idempotencyKey: "answer-key",
  });
  assert.deepEqual(fixture.calls.at(-1), {
    method: "respondToPendingRequest",
    input: {
      acpxRecordId: "record-1",
      requestId: "request-1",
      answer: { type: "select", option_id: "allow" },
      idempotencyKey: "answer-key",
    },
  });
});

test("adapter refuses ambiguous untagged interaction answers", async () => {
  const fixture = coreFixture();
  const service = adaptAcpxSessionService(fixture.core);
  await assert.rejects(
    service.respondToPendingRequest({
      acpxRecordId: "record-1",
      requestId: "request-1",
      response: { option_id: "allow" },
      idempotencyKey: "answer-key",
    }),
    /tagged answer/,
  );
});

test("browser session creation cannot inject an approve-all policy", async () => {
  const fixture = coreFixture();
  const service = adaptAcpxSessionService(fixture.core);
  await assert.rejects(
    service.createSession({
      agentId: "codex",
      cwd: "/workspace",
      policy: { defaultAction: "approve" },
      idempotencyKey: "unsafe-policy-key",
    }),
    /only accepts the defer-risky/,
  );
  assert.equal(fixture.calls.length, 0);
});

test("unknown agents require an explicit mode instead of inheriting an unsafe default", async () => {
  const fixture = coreFixture();
  const service = adaptAcpxSessionService(fixture.core);
  await assert.rejects(
    service.createSession({
      agentId: "custom-agent",
      cwd: "/workspace",
      idempotencyKey: "custom-agent-key",
    }),
    /mode is required for agent custom-agent/,
  );
  assert.equal(fixture.calls.length, 0);

  await service.createSession({
    agentId: "custom-agent",
    cwd: "/workspace",
    mode: "safe",
    idempotencyKey: "custom-agent-safe-key",
  });
  assert.equal((fixture.calls.at(-1)!.input as { mode?: string }).mode, "safe");
});

test("unknown agents require and preserve an explicit mode when adopting", async () => {
  const fixture = coreFixture();
  const service = adaptAcpxSessionService(fixture.core);
  await assert.rejects(
    service.adoptSession({
      agentId: "custom-agent",
      providerSessionId: "provider-custom",
      cwd: "/workspace",
      idempotencyKey: "custom-adopt-key",
    }),
    /mode is required for agent custom-agent/,
  );
  await assert.rejects(
    service.adoptSession({
      agentId: "custom-agent",
      providerSessionId: "provider-custom",
      cwd: "/workspace",
      mode: "   ",
      idempotencyKey: "custom-adopt-blank-mode-key",
    }),
    /mode is required for agent custom-agent/,
  );
  assert.equal(fixture.calls.length, 0);

  await service.adoptSession({
    agentId: "custom-agent",
    providerSessionId: "provider-custom",
    cwd: "/workspace",
    mode: "safe",
    idempotencyKey: "custom-adopt-safe-key",
  });
  assert.equal((fixture.calls.at(-1)!.input as { mode?: string }).mode, "safe");
});

test("built-in adoption retains the Codex and Claude safe defaults", async () => {
  const fixture = coreFixture();
  const service = adaptAcpxSessionService(fixture.core);

  await service.adoptSession({
    agentId: "codex",
    providerSessionId: "provider-codex",
    cwd: "/workspace",
    idempotencyKey: "codex-adopt-key",
  });
  assert.equal((fixture.calls.at(-1)!.input as { mode?: string }).mode, "read-only");

  await service.adoptSession({
    agentId: "claude",
    providerSessionId: "provider-claude",
    cwd: "/workspace",
    idempotencyKey: "claude-adopt-key",
  });
  assert.equal((fixture.calls.at(-1)!.input as { mode?: string }).mode, "default");
});
