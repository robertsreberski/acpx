import assert from "node:assert/strict";
import test from "node:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import {
  PendingRequestManager,
  type PendingRequestEvent,
} from "../src/cli/queue/pending-request-manager.js";
import { PendingRequestNotAnswerableError } from "../src/errors.js";
import { listPendingRequests, readPendingRequest } from "../src/session/pending-requests.js";
import type { AcpElicitationRequest } from "../src/types.js";
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

/**
 * Production expiry timers are intentionally unref'd so a parked request never
 * keeps an otherwise-idle queue owner alive. Tests awaiting expiry therefore
 * need their own bounded, referenced deadline: Node 22 correctly terminates a
 * test whose only remaining handle is the manager's unref'd timer.
 */
async function waitForExpiry<T>(decision: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("timed out waiting for pending request expiry")),
      2_000,
    );
  });
  try {
    return await Promise.race([decision, deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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
    const first = stored[0];
    assert.deepEqual(first?.kind === "permission" ? first.options : undefined, [
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
    await manager.respond(pending.requestId, { type: "select", option_id: "allow" });

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
      async () =>
        await manager.respond(pending.requestId, { type: "select", option_id: "not-offered" }),
      PendingRequestNotAnswerableError,
    );
    // The request stays parked and answerable.
    assert.equal((await readPendingRequest(SESSION_ID, pending.requestId))?.state, "pending");

    await manager.respond(pending.requestId, { type: "select", option_id: "reject" });
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
      async () => await manager.respond("no-such-request", { type: "select", option_id: "allow" }),
      PendingRequestNotAnswerableError,
    );

    await manager.respond(pending.requestId, { type: "select", option_id: "allow" });
    await decision;

    await assert.rejects(
      async () => await manager.respond(pending.requestId, { type: "select", option_id: "reject" }),
      PendingRequestNotAnswerableError,
    );
  });
});

test("expiry resolves with the reject option and marks the entry expired", async () => {
  await withTempHome(async () => {
    const { manager, events } = makeManager({ deferMaxAgeMs: 5 });
    const controller = new AbortController();
    const decision = park(manager, controller);

    assert.deepEqual(await waitForExpiry(decision), { outcome: "select", optionId: "reject" });
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

    assert.deepEqual(await waitForExpiry(decision), { outcome: "cancel" });
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

test("a throwing onEvent consumer cannot strand the parked turn", async () => {
  await withTempHome(async () => {
    const logs: string[] = [];
    const { manager } = makeManager({
      onEvent: () => {
        throw new Error("event consumer exploded");
      },
      log: (message) => logs.push(message),
    });
    const controller = new AbortController();

    // Every transition notifies the consumer; none of them may propagate.
    const decision = park(manager, controller);
    const [pending] = await waitForPending(manager, 1);
    assert(pending);
    await manager.respond(pending.requestId, { type: "select", option_id: "allow" });

    assert.deepEqual(await decision, { outcome: "select", optionId: "allow" });
    assert.equal((await readPendingRequest(SESSION_ID, pending.requestId))?.state, "answered");
    assert.equal(
      logs.filter((line) => line.includes("pending request event consumer threw")).length,
      2,
      `expected created+answered failures to be logged, got: ${JSON.stringify(logs)}`,
    );
  });
});

test("park records the ACP session id from the request, not the manager default", async () => {
  await withTempHome(async () => {
    const { manager } = makeManager({ acpSessionId: "stale-boot-session" });
    const controller = new AbortController();
    const decision = park(
      manager,
      controller,
      makeRequest({ sessionId: "acp-session-after-reconnect" }),
    );
    const [pending] = await waitForPending(manager, 1);
    assert.equal(pending?.acpSessionId, "acp-session-after-reconnect");

    controller.abort();
    await decision;
  });
});

test("cancelAll settles a park whose durable write is still in flight", async () => {
  await withTempHome(async () => {
    const { manager } = makeManager();
    const controller = new AbortController();
    // No await: cancelAll runs while park's write is still landing, which is
    // exactly the SIGTERM window that previously stranded the promise.
    const decision = park(manager, controller);
    await manager.cancelAll("shutdown");

    assert.deepEqual(await decision, { outcome: "cancel" });
    assert.deepEqual(await manager.listPending(), []);
  });
});

test("respond returns the settled entry so a responder need not re-read the store", async () => {
  await withTempHome(async () => {
    const { manager } = makeManager();
    const controller = new AbortController();
    const decision = park(manager, controller);
    const [pending] = await waitForPending(manager, 1);
    assert(pending);

    const settled = await manager.respond(pending.requestId, {
      type: "select",
      option_id: "allow",
    });

    assert.equal(settled.requestId, pending.requestId);
    assert.equal(settled.state, "answered");
    assert.equal(settled.resolution?.source, "cli");
    assert.equal(settled.resolution?.optionId, "allow");
    assert.deepEqual(settled, await readPendingRequest(SESSION_ID, pending.requestId));
    await decision;
  });
});

test("a decline answer selects the option the agent offered for rejection", async () => {
  await withTempHome(async () => {
    const { manager, events } = makeManager();
    const controller = new AbortController();
    const decision = park(manager, controller);
    const [pending] = await waitForPending(manager, 1);
    assert(pending);

    const settled = await manager.respond(pending.requestId, { type: "decline" });

    // Declining is answering with the agent's own reject option, not a
    // synthesized outcome the agent never offered.
    assert.deepEqual(await decision, { outcome: "select", optionId: "reject" });
    assert.equal(settled.state, "answered");
    assert.equal(settled.resolution?.optionId, "reject");
    assert.equal(settled.resolution?.source, "cli");
    assert.deepEqual(
      events.map((event) => event.event),
      ["created", "answered"],
    );
  });
});

test("a decline answer prefers reject_once over reject_always", async () => {
  await withTempHome(async () => {
    const { manager } = makeManager();
    const controller = new AbortController();
    const decision = park(
      manager,
      controller,
      makeRequest({
        options: [
          { optionId: "abort", name: "Abort", kind: "reject_always" },
          { optionId: "no", name: "No", kind: "reject_once" },
        ],
      }),
    );
    const [pending] = await waitForPending(manager, 1);
    assert(pending);

    await manager.respond(pending.requestId, { type: "decline" });
    assert.deepEqual(await decision, { outcome: "select", optionId: "no" });
  });
});

test("a decline answer is refused when the agent offered no rejection", async () => {
  await withTempHome(async () => {
    const { manager } = makeManager();
    const controller = new AbortController();
    const decision = park(
      manager,
      controller,
      makeRequest({ options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }),
    );
    const [pending] = await waitForPending(manager, 1);
    assert(pending);

    // Silently downgrading this to a cancel would report an outcome the agent
    // never offered, so the responder is told to pick one instead.
    await assert.rejects(
      async () => await manager.respond(pending.requestId, { type: "decline" }),
      (error: unknown) => {
        assert.equal(error instanceof PendingRequestNotAnswerableError, true);
        assert.match((error as Error).message, /offered: allow/);
        return true;
      },
    );
    assert.equal((await readPendingRequest(SESSION_ID, pending.requestId))?.state, "pending");

    controller.abort();
    await decision;
  });
});

test("a cancel answer settles the request as cancelled by the CLI", async () => {
  await withTempHome(async () => {
    const { manager, events } = makeManager();
    const controller = new AbortController();
    const decision = park(manager, controller);
    const [pending] = await waitForPending(manager, 1);
    assert(pending);

    const settled = await manager.respond(pending.requestId, { type: "cancel" });

    assert.deepEqual(await decision, { outcome: "cancel" });
    assert.equal(settled.state, "cancelled");
    assert.equal(settled.resolution?.optionId, undefined);
    // `cli` distinguishes an operator cancel from a turn or shutdown cancel.
    assert.equal(settled.resolution?.source, "cli");
    assert.deepEqual(
      events.map((event) => event.event),
      ["created", "cancelled"],
    );
    assert.deepEqual(await manager.listPending(), []);
  });
});

test("every answer arm is refused once the request has settled", async () => {
  await withTempHome(async () => {
    const { manager } = makeManager();
    const controller = new AbortController();
    const decision = park(manager, controller);
    const [pending] = await waitForPending(manager, 1);
    assert(pending);
    await manager.respond(pending.requestId, { type: "cancel" });
    await decision;

    for (const answer of [
      { type: "select", option_id: "allow" },
      { type: "decline" },
      { type: "cancel" },
    ] as const) {
      await assert.rejects(
        async () => await manager.respond(pending.requestId, answer),
        PendingRequestNotAnswerableError,
      );
    }
  });
});

const ASK_SCHEMA = {
  type: "object",
  properties: {
    question_0: {
      type: "string",
      oneOf: [
        { const: "Greeting A", title: "Greeting A" },
        { const: "Greeting B", title: "Greeting B" },
      ],
    },
    question_0_custom: { type: "string", title: "Other" },
  },
};

function makeElicitationRequest(
  overrides: Partial<AcpElicitationRequest> = {},
): AcpElicitationRequest {
  return {
    sessionId: "acp-session-1",
    message: "Which greeting should I use?",
    requestedSchema: ASK_SCHEMA,
    toolCallId: "ask-1",
    raw: {} as AcpElicitationRequest["raw"],
    ...overrides,
  };
}

function parkElicitation(
  manager: PendingRequestManager,
  controller: AbortController,
  request = makeElicitationRequest(),
) {
  return manager.parkElicitation(
    { request, taskRequestId: "task-1" },
    { signal: controller.signal },
  );
}

test("parkElicitation stores the agent's form and an accept answers it", async () => {
  await withTempHome(async () => {
    const { manager, events } = makeManager();
    const controller = new AbortController();
    const decision = parkElicitation(manager, controller);
    const [pending] = await waitForPending(manager, 1);
    assert(pending);
    assert.equal(pending.kind, "elicitation");

    const stored = await readPendingRequest(SESSION_ID, pending.requestId);
    assert.equal(stored?.kind, "elicitation");
    if (stored?.kind !== "elicitation") {
      throw new Error("expected an elicitation entry");
    }
    // Verbatim: the responder types its answer against exactly this.
    assert.deepEqual(stored.elicitation.requestedSchema, ASK_SCHEMA);
    assert.equal(stored.elicitation.message, "Which greeting should I use?");
    assert.equal(stored.elicitation.mode, "form");
    assert.equal(stored.elicitation.toolCallId, "ask-1");

    const settled = await manager.respond(pending.requestId, {
      type: "accept",
      content: { question_0: "Greeting A" },
    });

    // The content reaches the blocked ACP handler unchanged.
    assert.deepEqual(await decision, {
      outcome: "accept",
      content: { question_0: "Greeting A" },
    });
    assert.equal(settled.state, "answered");
    assert.equal(settled.resolution?.source, "cli");
    // The action is recorded; the answer itself is not, by design.
    assert.equal(settled.resolution?.action, "accept");
    assert.equal(settled.resolution?.optionId, undefined);
    assert.deepEqual(
      events.map((event) => event.event),
      ["created", "answered"],
    );
  });
});

test("an elicitation can be declined or cancelled, and says which it was", async () => {
  await withTempHome(async () => {
    const { manager } = makeManager();

    const declineController = new AbortController();
    const declined = parkElicitation(manager, declineController);
    const [first] = await waitForPending(manager, 1);
    assert(first);
    const declinedEntry = await manager.respond(first.requestId, { type: "decline" });
    // Declining is a real answer — "the form was skipped" — so it is answered,
    // not cancelled, and the agent is told `decline` rather than an option id.
    assert.deepEqual(await declined, { outcome: "decline" });
    assert.equal(declinedEntry.state, "answered");
    assert.equal(declinedEntry.resolution?.action, "decline");

    const cancelController = new AbortController();
    const cancelled = parkElicitation(manager, cancelController);
    const second = (await waitForPending(manager, 1)).find(
      (entry) => entry.requestId !== first.requestId,
    );
    assert(second);
    const cancelledEntry = await manager.respond(second.requestId, { type: "cancel" });
    assert.deepEqual(await cancelled, { outcome: "cancel" });
    assert.equal(cancelledEntry.state, "cancelled");
    assert.equal(cancelledEntry.resolution?.action, "cancel");
  });
});

test("expiry declines an elicitation and never accepts one", async () => {
  await withTempHome(async () => {
    const { manager, events } = makeManager({ deferMaxAgeMs: 5 });
    const controller = new AbortController();
    const decision = parkElicitation(manager, controller);

    // Nobody filled the form in, so the only truthful answer is that it was
    // skipped. Synthesizing content would put words in the operator's mouth.
    assert.deepEqual(await waitForExpiry(decision), { outcome: "decline" });

    const [pending] = await listPendingRequests(SESSION_ID);
    assert.equal(pending?.state, "expired");
    assert.equal(pending?.resolution?.source, "expiry");
    assert.equal(pending?.resolution?.action, "decline");
    assert.deepEqual(
      events.map((event) => event.event),
      ["created", "expired"],
    );
  });
});

test("aborting the turn cancels a parked elicitation", async () => {
  await withTempHome(async () => {
    const { manager } = makeManager();
    const controller = new AbortController();
    const decision = parkElicitation(manager, controller);
    const [pending] = await waitForPending(manager, 1);
    assert(pending);

    controller.abort();

    assert.deepEqual(await decision, { outcome: "cancel" });
    const stored = await readPendingRequest(SESSION_ID, pending.requestId);
    assert.equal(stored?.state, "cancelled");
    assert.equal(stored?.resolution?.source, "cancel");
    assert.equal(stored?.resolution?.action, "cancel");
  });
});

test("each kind refuses the other kind's answer and stays parked", async () => {
  await withTempHome(async () => {
    const { manager } = makeManager();
    const permissionController = new AbortController();
    const permission = park(manager, permissionController);
    const [parkedPermission] = await waitForPending(manager, 1);
    assert(parkedPermission);

    // A form answer is not an answer to a permission request.
    await assert.rejects(
      async () =>
        await manager.respond(parkedPermission.requestId, { type: "accept", content: {} }),
      (error: unknown) => {
        assert.equal(error instanceof PendingRequestNotAnswerableError, true);
        assert.match((error as Error).message, /--option, --decline or --cancel/);
        assert.match((error as Error).message, /offered: allow, reject/);
        return true;
      },
    );

    const elicitationController = new AbortController();
    const elicitation = parkElicitation(manager, elicitationController);
    const parkedElicitation = (await waitForPending(manager, 2)).find(
      (entry) => entry.requestId !== parkedPermission.requestId,
    );
    assert(parkedElicitation);

    // And an option id is not an answer to a form.
    await assert.rejects(
      async () =>
        await manager.respond(parkedElicitation.requestId, {
          type: "select",
          option_id: "allow",
        }),
      (error: unknown) => {
        assert.equal(error instanceof PendingRequestNotAnswerableError, true);
        assert.match((error as Error).message, /--field, --text, --decline or --cancel/);
        assert.match((error as Error).message, /fields: question_0, question_0_custom/);
        return true;
      },
    );

    // A refused answer leaves both requests answerable.
    assert.equal(
      (await readPendingRequest(SESSION_ID, parkedPermission.requestId))?.state,
      "pending",
    );
    assert.equal(
      (await readPendingRequest(SESSION_ID, parkedElicitation.requestId))?.state,
      "pending",
    );

    permissionController.abort();
    elicitationController.abort();
    await permission;
    await elicitation;
  });
});
