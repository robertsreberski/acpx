import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listSessions } from "../src/session/persistence.js";
import { AcpxSessionAdoptionError, createAcpxSessionService } from "../src/sessions.js";
import { withTempHome } from "./runtime-test-helpers.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

async function writeAgentConfig(
  homeDir: string,
  agents: Record<string, { args: string[]; command?: string }>,
): Promise<void> {
  await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, ".acpx", "config.json"),
    `${JSON.stringify({
      agents: Object.fromEntries(
        Object.entries(agents).map(([name, value]) => [
          name,
          { command: value.command ?? process.execPath, args: [MOCK_AGENT_PATH, ...value.args] },
        ]),
      ),
    })}\n`,
    "utf8",
  );
}

test("session service creates without prompting, replays idempotently, and lists providers", async () => {
  await withTempHome("acpx-sessions-service-integration-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const callLog = path.join(homeDir, "calls.ndjson");
    await fs.mkdir(cwd, { recursive: true });
    await writeAgentConfig(homeDir, {
      mock: {
        args: [
          "--supports-load-session",
          "--supports-resume-session",
          "--supports-list-sessions",
          "--call-log",
          callLog,
        ],
      },
    });
    const service = createAcpxSessionService({ cwd });

    const first = await service.createSession({
      agentId: "mock",
      cwd,
      name: "created-without-prompt",
      idempotencyKey: "create-no-prompt",
    });
    const replay = await service.createSession({
      agentId: "mock",
      cwd,
      name: "created-without-prompt",
      idempotencyKey: "create-no-prompt",
    });

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.acpxRecordId, first.result.acpxRecordId);
    assert.equal(first.result.ownerState, "absent");
    assert.equal(first.result.turnState, "idle");
    assert.equal(first.result.agentId, "mock");
    assert.ok((await service.listAgents()).some((agent) => agent.agentId === "mock"));
    const calls = (await fs.readFile(callLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string });
    assert.equal(calls.filter((entry) => entry.method === "session/new").length, 1);
    assert.equal(
      calls.some((entry) => entry.method === "session/prompt"),
      false,
    );

    const providers = await service.listProviderSessions({ agentId: "mock", cwd });
    assert.deepEqual(
      providers.sessions.map((entry) => entry.providerSessionId),
      ["mock-session-alpha", "mock-session-gamma"],
    );
    assert.equal(providers.sessions[0]?.title, "Alpha task");
    service.dispose();
  });
});

test("session creation recovers the persisted provider record after post-create mode failure", async () => {
  await withTempHome("acpx-sessions-service-integration-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const callLog = path.join(homeDir, "calls.ndjson");
    const failOnceMarker = path.join(homeDir, "mode-failed-once");
    await fs.mkdir(cwd, { recursive: true });
    await writeAgentConfig(homeDir, {
      recoverable: {
        args: [
          "--supports-resume-session",
          "--set-session-mode-fails-once",
          failOnceMarker,
          "--call-log",
          callLog,
        ],
      },
    });
    const service = createAcpxSessionService({ cwd });
    const input = {
      agentId: "recoverable",
      cwd,
      mode: "plan",
      idempotencyKey: "recover-create",
    };

    await assert.rejects(async () => await service.createSession(input), /Internal error/);
    const [persisted] = await listSessions();
    assert.ok(persisted);

    const recovered = await service.createSession(input);
    assert.equal(recovered.replayed, true);
    assert.equal(recovered.result.acpxRecordId, persisted.acpxRecordId);
    assert.equal(recovered.result.mode, "plan");
    assert.equal((await listSessions()).length, 1);
    const calls = (await fs.readFile(callLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string });
    assert.equal(calls.filter((entry) => entry.method === "session/new").length, 1);
    assert.equal(calls.filter((entry) => entry.method === "session/resume").length, 1);
    service.dispose();
  });
});

test("session creation with a fresh key reconciles a post-create mode failure", async () => {
  await withTempHome("acpx-sessions-service-integration-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const callLog = path.join(homeDir, "fresh-create-calls.ndjson");
    const failOnceMarker = path.join(homeDir, "fresh-create-mode-failed-once");
    await fs.mkdir(cwd, { recursive: true });
    await writeAgentConfig(homeDir, {
      recoverable: {
        args: [
          "--supports-resume-session",
          "--set-session-mode-fails-once",
          failOnceMarker,
          "--call-log",
          callLog,
        ],
      },
    });
    const service = createAcpxSessionService({ cwd });
    const firstInput = {
      agentId: "recoverable",
      cwd,
      mode: "plan",
      idempotencyKey: "fresh-create-first",
    };

    await assert.rejects(async () => await service.createSession(firstInput), /Internal error/u);
    const [partial] = await listSessions();
    assert.ok(partial);

    const recovered = await service.createSession({
      ...firstInput,
      idempotencyKey: "fresh-create-second",
    });
    const originalReplay = await service.createSession(firstInput);
    assert.equal(recovered.replayed, true);
    assert.equal(recovered.result.acpxRecordId, partial.acpxRecordId);
    assert.equal(recovered.result.mode, "plan");
    assert.equal(originalReplay.replayed, true);
    assert.equal(originalReplay.result.acpxRecordId, partial.acpxRecordId);
    assert.equal((await listSessions()).length, 1);
    const calls = (await fs.readFile(callLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string });
    assert.equal(calls.filter((entry) => entry.method === "session/new").length, 1);
    assert.equal(calls.filter((entry) => entry.method === "session/resume").length, 1);
    service.dispose();
  });
});

test("adoption with a fresh key reconciles a post-adopt mode failure", async () => {
  await withTempHome("acpx-sessions-service-integration-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const callLog = path.join(homeDir, "fresh-adopt-calls.ndjson");
    const failOnceMarker = path.join(homeDir, "fresh-adopt-mode-failed-once");
    await fs.mkdir(cwd, { recursive: true });
    await writeAgentConfig(homeDir, {
      recoverable: {
        args: [
          "--supports-resume-session",
          "--supports-list-sessions",
          "--set-session-mode-fails-once",
          failOnceMarker,
          "--call-log",
          callLog,
        ],
      },
    });
    const service = createAcpxSessionService({ cwd });
    const [provider] = (await service.listProviderSessions({ agentId: "recoverable", cwd }))
      .sessions;
    assert.ok(provider);
    const firstInput = {
      agentId: "recoverable",
      cwd,
      mode: "plan",
      providerSessionId: provider.providerSessionId,
      idempotencyKey: "fresh-adopt-first",
    };

    await assert.rejects(async () => await service.adoptSession(firstInput), /Internal error/u);
    const [partial] = await listSessions();
    assert.ok(partial);

    const recovered = await service.adoptSession({
      ...firstInput,
      idempotencyKey: "fresh-adopt-second",
    });
    const originalReplay = await service.adoptSession(firstInput);
    assert.equal(recovered.replayed, true);
    assert.equal(recovered.result.acpxRecordId, partial.acpxRecordId);
    assert.equal(recovered.result.acpSessionId, provider.providerSessionId);
    assert.equal(recovered.result.mode, "plan");
    assert.equal(originalReplay.replayed, true);
    assert.equal(originalReplay.result.acpxRecordId, partial.acpxRecordId);
    assert.equal((await listSessions()).length, 1);
    const calls = (await fs.readFile(callLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string });
    assert.equal(calls.filter((entry) => entry.method === "session/new").length, 0);
    assert.equal(calls.filter((entry) => entry.method === "session/resume").length, 2);
    service.dispose();
  });
});

test("adoption is strict and never replaces an unsupported provider session with a new one", async () => {
  await withTempHome("acpx-sessions-service-integration-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const callLog = path.join(homeDir, "calls.ndjson");
    await fs.mkdir(cwd, { recursive: true });
    await writeAgentConfig(homeDir, {
      rigid: { args: ["--call-log", callLog] },
    });
    const service = createAcpxSessionService({ cwd });

    await assert.rejects(
      async () =>
        await service.adoptSession({
          agentId: "rigid",
          cwd,
          providerSessionId: "must-exist-upstream",
          idempotencyKey: "strict-adoption",
        }),
      AcpxSessionAdoptionError,
    );
    assert.equal((await listSessions()).length, 0);
    await assert.rejects(async () => await fs.access(callLog));
    service.dispose();
  });
});

test("a listed provider session can be adopted by its exact provider id", async () => {
  await withTempHome("acpx-sessions-service-integration-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeAgentConfig(homeDir, {
      resumable: { args: ["--supports-resume-session", "--supports-list-sessions"] },
    });
    const service = createAcpxSessionService({ cwd });
    const listed = await service.listProviderSessions({ agentId: "resumable", cwd });
    const provider = listed.sessions[0];
    assert.ok(provider);

    const adopted = await service.adoptSession({
      agentId: "resumable",
      cwd,
      providerSessionId: provider.providerSessionId,
      idempotencyKey: "adopt-listed-provider",
    });
    assert.notEqual(adopted.result.acpxRecordId, provider.providerSessionId);
    assert.equal(adopted.result.acpSessionId, provider.providerSessionId);
    service.dispose();
  });
});

test("duplicate provider adoption survives configured command drift without reconnecting", async () => {
  await withTempHome("acpx-sessions-service-integration-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const callLog = path.join(homeDir, "calls.ndjson");
    const replacementCommand = path.join(homeDir, "not-installed-node-replacement");
    await fs.mkdir(cwd, { recursive: true });
    await writeAgentConfig(homeDir, {
      resumable: {
        args: ["--supports-resume-session", "--supports-list-sessions", "--call-log", callLog],
      },
    });
    const firstService = createAcpxSessionService({ cwd });
    const [provider] = (await firstService.listProviderSessions({ agentId: "resumable", cwd }))
      .sessions;
    assert.ok(provider);

    const first = await firstService.adoptSession({
      agentId: "resumable",
      cwd,
      name: "first-name",
      providerSessionId: provider.providerSessionId,
      idempotencyKey: "adopt-provider-first",
    });
    firstService.dispose();

    await writeAgentConfig(homeDir, {
      resumable: {
        command: replacementCommand,
        args: ["--supports-resume-session", "--supports-list-sessions", "--call-log", callLog],
      },
    });
    const replacementService = createAcpxSessionService({ cwd });
    const duplicate = await replacementService.adoptSession({
      agentId: "resumable",
      cwd,
      name: "different-name",
      providerSessionId: provider.providerSessionId,
      idempotencyKey: "adopt-provider-again",
    });

    assert.equal(duplicate.replayed, false);
    assert.equal(duplicate.result.acpxRecordId, first.result.acpxRecordId);
    assert.equal(duplicate.result.name, "first-name");
    assert.equal(duplicate.result.agentId, "resumable");
    assert.equal((await listSessions()).length, 1);
    const calls = (await fs.readFile(callLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string });
    assert.equal(calls.filter((entry) => entry.method === "session/resume").length, 1);
    replacementService.dispose();
  });
});

test("adapter-scoped provider ids can map to distinct registered agent identities", async () => {
  await withTempHome("acpx-sessions-service-integration-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeAgentConfig(homeDir, {
      alpha: { args: ["--supports-resume-session", "--supports-list-sessions"] },
      beta: { args: ["--supports-resume-session", "--supports-list-sessions"] },
    });
    const service = createAcpxSessionService({ cwd });
    const [provider] = (await service.listProviderSessions({ agentId: "alpha", cwd })).sessions;
    assert.ok(provider);

    const adopted = await service.adoptSession({
      agentId: "alpha",
      cwd,
      providerSessionId: provider.providerSessionId,
      idempotencyKey: "adopt-alpha-provider",
    });

    const beta = await service.adoptSession({
      agentId: "beta",
      cwd,
      providerSessionId: provider.providerSessionId,
      idempotencyKey: "adopt-beta-provider",
    });
    const records = await listSessions();
    assert.equal(records.length, 2);
    assert.notEqual(beta.result.acpxRecordId, adopted.result.acpxRecordId);
    assert.equal(beta.result.acpSessionId, adopted.result.acpSessionId);
    assert.deepEqual(
      records
        .map((record) => record.acpx?.agent_id)
        .toSorted((left, right) => String(left).localeCompare(String(right))),
      ["alpha", "beta"],
    );
    assert.equal(
      (await service.getSession({ acpxRecordId: adopted.result.acpxRecordId }))?.agentId,
      "alpha",
    );
    assert.equal(
      (await service.getSession({ acpxRecordId: beta.result.acpxRecordId }))?.agentId,
      "beta",
    );
    service.dispose();
  });
});

test("fresh sessions use collision-safe local ids when adapters return the same provider id", async () => {
  await withTempHome("acpx-sessions-service-integration-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const sharedProviderId = "adapter-scoped-provider-id";
    await writeAgentConfig(homeDir, {
      alpha: { args: ["--fixed-new-session-id", sharedProviderId] },
      beta: { args: ["--fixed-new-session-id", sharedProviderId] },
    });
    const service = createAcpxSessionService({ cwd });

    const alpha = await service.createSession({
      agentId: "alpha",
      cwd,
      idempotencyKey: "create-alpha-collision",
    });
    const beta = await service.createSession({
      agentId: "beta",
      cwd,
      idempotencyKey: "create-beta-collision",
    });

    assert.notEqual(alpha.result.acpxRecordId, beta.result.acpxRecordId);
    assert.equal(alpha.result.acpSessionId, sharedProviderId);
    assert.equal(beta.result.acpSessionId, sharedProviderId);
    assert.equal(alpha.result.agentId, "alpha");
    assert.equal(beta.result.agentId, "beta");
    const records = await listSessions();
    assert.equal(records.length, 2);
    assert.deepEqual(
      records
        .map((record) => record.acpx?.agent_id)
        .toSorted((left, right) => String(left).localeCompare(String(right))),
      ["alpha", "beta"],
    );
    service.dispose();
  });
});

test("the service drives create, queue, park, answer, transcript, and close end to end", async () => {
  await withTempHome("acpx-sessions-service-integration-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeAgentConfig(homeDir, { queue: { args: ["--supports-resume-session"] } });
    const service = createAcpxSessionService({ cwd, pendingResponseTimeoutMs: 2_000 });
    try {
      const created = await service.createSession({
        agentId: "queue",
        cwd,
        idempotencyKey: "queue-create",
      });
      const enqueued = await service.enqueuePrompt({
        acpxRecordId: created.result.acpxRecordId,
        prompt: "permission execute Run the focused checks",
        idempotencyKey: "queue-enqueue",
      });
      assert.equal(enqueued.result.admission, "queued");

      const pending = await waitFor(async () => {
        const entries = await service.listPendingRequests({
          acpxRecordId: created.result.acpxRecordId,
        });
        return entries.find((entry) => entry.state === "pending");
      });
      assert.equal(pending.kind, "permission");
      assert.equal(pending.title, "Run the focused checks");
      const waiting = await service.getSession({ acpxRecordId: created.result.acpxRecordId });
      assert.equal(waiting?.turnState, "waiting_permission");
      assert.equal(waiting?.activeTurnId, enqueued.result.turnId);

      const answered = await service.respondToPendingRequest({
        acpxRecordId: created.result.acpxRecordId,
        requestId: pending.requestId,
        answer: { type: "select", option_id: "allow" },
        idempotencyKey: "queue-answer",
      });
      assert.equal(answered.result.state, "answered");
      await waitFor(async () => {
        const session = await service.getSession({ acpxRecordId: created.result.acpxRecordId });
        return session?.turnState === "completed" ? session : undefined;
      });

      const transcript = await service.getTranscriptPage({
        acpxRecordId: created.result.acpxRecordId,
        limit: 100,
      });
      const turnEvents = transcript.items.filter(
        (item) => "turn_id" in item && item.turn_id === enqueued.result.turnId,
      );
      assert.ok(turnEvents.length >= 3);
      assert.equal(
        turnEvents.some(
          (item) =>
            "payload" in item &&
            item.payload.kind === "lifecycle" &&
            item.payload.event.type === "turn_completed",
        ),
        true,
      );

      const closed = await service.closeSession({
        acpxRecordId: created.result.acpxRecordId,
        idempotencyKey: "queue-close",
      });
      assert.equal(closed.result.sessionState, "closed");
    } finally {
      service.dispose();
    }
  });
});
