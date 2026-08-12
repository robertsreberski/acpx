import assert from "node:assert/strict";
import test from "node:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import {
  PendingRequestManager,
  type PendingRequestEvent,
} from "../src/cli/queue/pending-request-manager.js";
import { PendingRequestNotAnswerableError } from "../src/errors.js";
import { listPendingRequests, readPendingRequest } from "../src/session/pending-requests.js";
import { withTempHome } from "./queue-test-helpers.js";

const SESSION_ID = "manager-session";

function makeRequest(overrides: Partial<RequestPermissionRequest> = {}): RequestPermissionRequest {
  return {
    sessionId: "acp-session-1",
    toolCall: {
      toolCallId: "tool-1",
      kind: "execute",
      title: "Bash: pnpm test",
      rawInput: { command: "pnpm test" },
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
    ...overrides,
  };
}

function makeManager(
  overrides: Partial<ConstructorParameters<typeof PendingRequestManager>[0]> = {},
): { manager: PendingRequestManager; events: PendingRequestEvent[] } {
  const events: PendingRequestEvent[] = [];
  const manager = new PendingRequestManager({
    sessionId: SESSION_ID,
    acpSessionId: "acp-session-1",
    agentCommand: "node ./test/mock-agent.js",
    cwd: "/workspace",
    ownerGeneration: 4242,
    ownerPid: 999,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { manager, events };
}

/**
 * park() writes the durable entry and only then registers the in-memory
 * waiter, so observing `count` waiters proves that many entries are on disk.
 */
async function waitForPending(
  manager: PendingRequestManager,
  count: number,
): Promise<Awaited<ReturnType<PendingRequestManager["listPending"]>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const pending = await manager.listPending();
    if (pending.length >= count) {
      return pending;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${count} parked request(s)`);
}

function park(
  manager: PendingRequestManager,
  controller: AbortController,
  request = makeRequest(),
) {
  return manager.park(
    { request, taskRequestId: "task-1", action: "defer" },
    { signal: controller.signal },
  );
}

test("park writes the entry before returning control to the caller", async () => {
  await withTempHome(async () => {
    const { manager, events } = makeManager();
    const controller = new AbortController();
    const decision = park(manager, controller);
    await waitForPending(manager, 1);

    // A lister racing the park must already see it: park awaits the write
    // before the request is in flight.
    const stored = await listPendingRequests(SESSION_ID);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.state, "pending");
    assert.equal(stored[0]?.taskRequestId, "task-1");
    assert.deepEqual(stored[0]?.options, [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ]);
    assert.deepEqual(
      events.map((event) => event.event),
      ["created"],
    );

    controller.abort();
    assert.deepEqual(await decision, { outcome: "cancel" });
  });
});

test("respond resolves the parked request with the selected option", async () => {
  await withTempHome(async () => {
    const { manager, events } = makeManager();
    const controller = new AbortController();
    const decision = park(manager, controller);
    const [pending] = await waitForPending(manager, 1);
    assert(pending);
    await manager.respond(pending.requestId, { optionId: "allow" });

    assert.deepEqual(await decision, { outcome: "select", optionId: "allow" });
    const stored = await readPendingRequest(SESSION_ID, pending.requestId);
    assert.equal(stored?.state, "answered");
    assert.equal(stored?.resolution?.source, "cli");
    assert.equal(stored?.resolution?.optionId, "allow");
    assert.deepEqual(
      events.map((event) => event.event),
      ["created", "answered"],
    );
  });
});

test("respond rejects an option the agent never offered", async () => {
  await withTempHome(async () => {
    const { manager } = makeManager();
    const controller = new AbortController();
    const decision = park(manager, controller);
    const [pending] = await waitForPending(manager, 1);
    assert(pending);

    await assert.rejects(
      async () => await manager.respond(pending.requestId, { optionId: "not-offered" }),
      PendingRequestNotAnswerableError,
    );
    // The request stays parked and answerable.
    assert.equal((await readPendingRequest(SESSION_ID, pending.requestId))?.state, "pending");

    await manager.respond(pending.requestId, { optionId: "reject" });
    assert.deepEqual(await decision, { outcome: "select", optionId: "reject" });
  });
});

test("respond rejects unknown and already-settled requests", async () => {
  await withTempHome(async () => {
    const { manager } = makeManager();
    const controller = new AbortController();
    const decision = park(manager, controller);
    const [pending] = await waitForPending(manager, 1);
    assert(pending);

    await assert.rejects(
      async () => await manager.respond("no-such-request", { optionId: "allow" }),
      PendingRequestNotAnswerableError,
    );

    await manager.respond(pending.requestId, { optionId: "allow" });
    await decision;

    await assert.rejects(
      async () => await manager.respond(pending.requestId, { optionId: "reject" }),
      PendingRequestNotAnswerableError,
    );
  });
});

test("expiry resolves with the reject option and marks the entry expired", async () => {
  await withTempHome(async () => {
    const { manager, events } = makeManager({ deferMaxAgeMs: 5 });
    const controller = new AbortController();
    const decision = park(manager, controller);

    assert.deepEqual(await decision, { outcome: "select", optionId: "reject" });
    const [stored] = await listPendingRequests(SESSION_ID);
    assert.equal(stored?.state, "expired");
    assert.equal(stored?.resolution?.source, "expiry");
    assert.equal(stored?.resolution?.optionId, "reject");
    assert.equal(stored?.expiresAt !== undefined, true);
    assert.deepEqual(
      events.map((event) => event.event),
      ["created", "expired"],
    );
  });
});

test("expiry cancels when the agent offered no reject option", async () => {
  await withTempHome(async () => {
    const { manager } = makeManager({ deferMaxAgeMs: 5 });
    const controller = new AbortController();
    const decision = park(
      manager,
      controller,
      makeRequest({ options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }),
    );

    assert.deepEqual(await decision, { outcome: "cancel" });
    const [stored] = await listPendingRequests(SESSION_ID);
    assert.equal(stored?.state, "expired");
    assert.equal(stored?.resolution?.optionId, undefined);
  });
});

test("deferMaxAgeMs of zero parks indefinitely", async () => {
  await withTempHome(async () => {
    const { manager } = makeManager({ deferMaxAgeMs: 0 });
    const controller = new AbortController();
    const decision = park(manager, controller);
    await waitForPending(manager, 1);

    const [stored] = await listPendingRequests(SESSION_ID);
    assert.equal(stored?.expiresAt, undefined);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await manager.listPending()).length, 1);

    controller.abort();
    assert.deepEqual(await decision, { outcome: "cancel" });
  });
});

test("abort cancels the parked request", async () => {
  await withTempHome(async () => {
    const { manager, events } = makeManager();
    const controller = new AbortController();
    const decision = park(manager, controller);
    await waitForPending(manager, 1);

    controller.abort();
    assert.deepEqual(await decision, { outcome: "cancel" });

    const [stored] = await listPendingRequests(SESSION_ID);
    assert.equal(stored?.state, "cancelled");
    assert.equal(stored?.resolution?.source, "cancel");
    assert.deepEqual(
      events.map((event) => event.event),
      ["created", "cancelled"],
    );
    assert.deepEqual(await manager.listPending(), []);
  });
});

test("park on an already-aborted signal resolves immediately", async () => {
  await withTempHome(async () => {
    const { manager } = makeManager();
    const controller = new AbortController();
    controller.abort();

    assert.deepEqual(await park(manager, controller), { outcome: "cancel" });
    const [stored] = await listPendingRequests(SESSION_ID);
    assert.equal(stored?.state, "cancelled");
  });
});

test("cancelAll unwinds every parked request", async () => {
  await withTempHome(async () => {
    const { manager, events } = makeManager();
    const controller = new AbortController();
    const first = park(manager, controller, makeRequest({ sessionId: "acp-session-1" }));
    await waitForPending(manager, 1);
    const second = manager.park(
      {
        request: makeRequest({ toolCall: { toolCallId: "tool-2", title: "Write", kind: "edit" } }),
        taskRequestId: "task-2",
        action: "defer",
      },
      { signal: controller.signal },
    );
    await waitForPending(manager, 2);

    await manager.cancelAll("shutdown");

    assert.deepEqual(await first, { outcome: "cancel" });
    assert.deepEqual(await second, { outcome: "cancel" });
    assert.deepEqual(await manager.listPending(), []);

    const stored = await listPendingRequests(SESSION_ID);
    assert.equal(stored.length, 2);
    for (const entry of stored) {
      assert.equal(entry.state, "cancelled");
      assert.equal(entry.resolution?.source, "shutdown");
    }
    assert.deepEqual(events.filter((event) => event.event === "cancelled").length, 2);
  });
});

test("cancelAll is safe with nothing parked", async () => {
  await withTempHome(async () => {
    const { manager } = makeManager();
    await manager.cancelAll("shutdown");
    assert.deepEqual(await manager.listPending(), []);
  });
});

test("listPending reports only in-flight requests from this owner", async () => {
  await withTempHome(async () => {
    const { manager } = makeManager();
    const controller = new AbortController();
    const decision = park(manager, controller);

    const pending = await waitForPending(manager, 1);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.ownerGeneration, 4242);
    assert.equal(pending[0]?.ownerPid, 999);

    controller.abort();
    await decision;
    assert.deepEqual(await manager.listPending(), []);
  });
});
