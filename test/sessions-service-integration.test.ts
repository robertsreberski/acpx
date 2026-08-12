import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listSessions } from "../src/session/persistence.js";
import { AcpxSessionAdoptionError, createAcpxSessionService } from "../src/sessions.js";
import { withTempHome } from "./runtime-test-helpers.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const QUEUE_OWNER_CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

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
  agents: Record<string, { args: string[] }>,
): Promise<void> {
  await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, ".acpx", "config.json"),
    `${JSON.stringify({
      agents: Object.fromEntries(
        Object.entries(agents).map(([name, value]) => [
          name,
          { command: process.execPath, args: [MOCK_AGENT_PATH, ...value.args] },
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
    assert.equal(adopted.result.acpxRecordId, provider.providerSessionId);
    assert.equal(adopted.result.acpSessionId, provider.providerSessionId);
    service.dispose();
  });
});

test("the service drives create, queue, park, answer, transcript, and close end to end", async () => {
  await withTempHome("acpx-sessions-service-integration-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeAgentConfig(homeDir, { queue: { args: ["--supports-resume-session"] } });
    const previousOwnerArgs = process.env.ACPX_QUEUE_OWNER_ARGS;
    process.env.ACPX_QUEUE_OWNER_ARGS = JSON.stringify([QUEUE_OWNER_CLI_PATH, "__queue-owner"]);
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
      if (previousOwnerArgs === undefined) {
        delete process.env.ACPX_QUEUE_OWNER_ARGS;
      } else {
        process.env.ACPX_QUEUE_OWNER_ARGS = previousOwnerArgs;
      }
    }
  });
});
