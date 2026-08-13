import assert from "node:assert/strict";
import test from "node:test";
import {
  tryApplySessionPreferencesOnRunningOwner,
  trySubmitToRunningOwner,
} from "../src/cli/queue/ipc.js";
import {
  QUEUE_PROTOCOL_COMPLETION_STATUS_VERSION,
  QUEUE_PROTOCOL_EFFORT_VERSION,
  QUEUE_PROTOCOL_RULE_KEY_COUNT,
  QUEUE_PROTOCOL_VERSION,
  queueOwnerProtocolVersion,
  readQueueOwnerRecord,
  refreshQueueOwnerLease,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/lease-store.js";
import { DEFAULT_DEFER_MAX_AGE_MS } from "../src/cli/queue/pending-request-manager.js";
import { QueueConnectionError } from "../src/errors.js";
import { PERMISSION_POLICY_RULE_KEYS } from "../src/types.js";
import type { OutputFormatter, PermissionPolicy } from "../src/types.js";
import {
  queuePaths,
  startKeeperProcess,
  stopProcess,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";

function noopFormatter(): OutputFormatter {
  const noop = () => {
    // queue protocol gating rejects before anything is formatted
  };
  return new Proxy({} as OutputFormatter, {
    get: () => noop,
  });
}

async function submitWithPolicy(params: {
  sessionId: string;
  permissionPolicy?: PermissionPolicy;
  defer?: boolean;
  deferMaxAgeMs?: number;
  effort?: string;
  waitForCompletion?: boolean;
}): Promise<unknown> {
  return await trySubmitToRunningOwner({
    sessionId: params.sessionId,
    message: "hello",
    permissionMode: "approve-all",
    ...(params.permissionPolicy ? { permissionPolicy: params.permissionPolicy } : {}),
    ...(params.defer ? { defer: true } : {}),
    ...(params.deferMaxAgeMs === undefined ? {} : { deferMaxAgeMs: params.deferMaxAgeMs }),
    ...(params.effort ? { sessionOptions: { effort: params.effort } } : {}),
    outputFormatter: noopFormatter(),
    waitForCompletion: params.waitForCompletion ?? true,
  });
}

async function assertParkingRefusal(
  params: Parameters<typeof submitWithPolicy>[0],
  messagePattern: RegExp,
): Promise<void> {
  await assert.rejects(
    async () => await submitWithPolicy(params),
    (error: unknown) => {
      const queueError = error as QueueConnectionError;
      assert.equal(queueError.detailCode, "QUEUE_OWNER_PARKING_UNSUPPORTED");
      assert.equal(queueError.retryable, false);
      assert.match(queueError.message, messagePattern);
      return true;
    },
  );
}

/**
 * Stand up a live-looking owner lease whose recorded protocol version we
 * control. The pid belongs to a real idle process so the owner passes the
 * liveness and heartbeat checks and the request reaches the protocol gate.
 */
async function withFakeOwner(
  homeDir: string,
  sessionId: string,
  fields: {
    queueProtocol?: number;
    acpxVersion?: string;
    parking?: boolean;
    parkingMaxAgeMs?: number;
    heartbeatAt?: string;
  },
  run: () => Promise<void>,
): Promise<void> {
  const keeper = await startKeeperProcess();
  const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
  try {
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
      queueProtocol: fields.queueProtocol ?? null,
      ...fields,
    });
    await run();
  } finally {
    stopProcess(keeper);
  }
}

const DEFER_POLICY: PermissionPolicy = { defer: ["execute"] };

async function assertOlderOwnerRefusesPrompt(params: {
  homeDir: string;
  sessionId: string;
  queueProtocol?: number;
  heartbeatAt?: string;
  waitForCompletion: boolean;
}): Promise<void> {
  await withFakeOwner(
    params.homeDir,
    params.sessionId,
    {
      ...(params.queueProtocol === undefined ? {} : { queueProtocol: params.queueProtocol }),
      ...(params.heartbeatAt === undefined ? {} : { heartbeatAt: params.heartbeatAt }),
      acpxVersion: "0.13.0",
    },
    async () => {
      const before = await readQueueOwnerRecord(params.sessionId);
      assert(before);
      await assert.rejects(
        async () =>
          await submitWithPolicy({
            sessionId: params.sessionId,
            waitForCompletion: params.waitForCompletion,
          }),
        (error: unknown) => {
          const queueError = error as QueueConnectionError;
          assert.equal(queueError.detailCode, "QUEUE_OWNER_PROTOCOL_MISMATCH");
          assert.equal(queueError.retryable, true);
          assert.match(queueError.message, /cannot report current prompt completion semantics/);
          return true;
        },
      );
      const after = await readQueueOwnerRecord(params.sessionId);
      assert.equal(after?.ownerGeneration, before.ownerGeneration);
    },
  );
}

test("a legacy queue owner refuses a waited prompt without disturbing existing work", async () => {
  await withTempHome(async (homeDir) => {
    await assertOlderOwnerRefusesPrompt({
      homeDir,
      sessionId: "owner-legacy-waited",
      waitForCompletion: true,
    });
  });
});

test("a v2 queue owner refuses a no-wait prompt without disturbing existing work", async () => {
  await withTempHome(async (homeDir) => {
    await assertOlderOwnerRefusesPrompt({
      homeDir,
      sessionId: "owner-v2-no-wait",
      queueProtocol: 2,
      waitForCompletion: false,
    });
  });
});

test("a v3 queue owner refuses prompts that require completion status", async () => {
  await withTempHome(async (homeDir) => {
    await assertOlderOwnerRefusesPrompt({
      homeDir,
      sessionId: "owner-v3-waited",
      queueProtocol: QUEUE_PROTOCOL_COMPLETION_STATUS_VERSION - 1,
      waitForCompletion: true,
    });
  });
});

test("a stale-heartbeat v3 owner is rejected without liveness recovery", async () => {
  await withTempHome(async (homeDir) => {
    await assertOlderOwnerRefusesPrompt({
      homeDir,
      sessionId: "owner-v3-stale-heartbeat",
      queueProtocol: QUEUE_PROTOCOL_COMPLETION_STATUS_VERSION - 1,
      heartbeatAt: "2000-01-01T00:00:00.000Z",
      waitForCompletion: true,
    });
  });
});

test("a dead v3 owner is retired so a current owner can replace it", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "owner-v3-dead";
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: 2_147_483_647,
      sessionId,
      socketPath,
      queueProtocol: QUEUE_PROTOCOL_COMPLETION_STATUS_VERSION - 1,
    });

    assert(await readQueueOwnerRecord(sessionId));
    assert.equal(await submitWithPolicy({ sessionId }), undefined);
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);
  });
});

/**
 * Passing the gate means the request reached the transport. These leases have no
 * socket behind them, so the transport failure (QUEUE_NOT_ACCEPTING_REQUESTS) is
 * the signal that gating let the request through.
 */
async function assertReachesTransport(
  params: Parameters<typeof submitWithPolicy>[0],
): Promise<void> {
  await assert.rejects(
    async () => await submitWithPolicy(params),
    (error: unknown) => {
      const detailCode = (error as QueueConnectionError).detailCode;
      assert.notEqual(
        detailCode,
        "QUEUE_OWNER_PROTOCOL_MISMATCH",
        "request should not have been gated",
      );
      assert.equal(detailCode, "QUEUE_NOT_ACCEPTING_REQUESTS");
      return true;
    },
  );
}

test("a current queue owner accepts defer policies", async () => {
  await withTempHome(async (homeDir) => {
    await withFakeOwner(
      homeDir,
      "owner-current-defer",
      { queueProtocol: QUEUE_PROTOCOL_VERSION },
      async () => {
        await assertReachesTransport({
          sessionId: "owner-current-defer",
          permissionPolicy: DEFER_POLICY,
        });
      },
    );
  });
});

test("a current queue owner accepts effort-bearing prompts", async () => {
  await withTempHome(async (homeDir) => {
    await withFakeOwner(
      homeDir,
      "owner-current-effort",
      { queueProtocol: QUEUE_PROTOCOL_VERSION },
      async () => {
        await assertReachesTransport({
          sessionId: "owner-current-effort",
          effort: "high",
        });
      },
    );
  });
});

test("a pre-effort queue owner is retired so combined preferences can reconnect", async () => {
  await withTempHome(async (homeDir) => {
    await withFakeOwner(
      homeDir,
      "owner-pre-effort-control",
      { queueProtocol: QUEUE_PROTOCOL_EFFORT_VERSION - 1 },
      async () => {
        const result = await tryApplySessionPreferencesOnRunningOwner({
          sessionId: "owner-pre-effort-control",
          modelId: "smart-model",
          effort: "high",
        });

        assert.equal(result, undefined);
        assert.equal(await readQueueOwnerRecord("owner-pre-effort-control"), undefined);
      },
    );
  });
});

test("a freshly acquired lease stamps the queue protocol version and acpx build", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-stamped");
    assert(lease);

    const owner = await readQueueOwnerRecord("owner-stamped");
    assert(owner);
    assert.equal(owner.queueProtocol, QUEUE_PROTOCOL_VERSION);
    assert.equal(queueOwnerProtocolVersion(owner), QUEUE_PROTOCOL_VERSION);
    assert.equal(typeof owner.acpxVersion, "string");
    assert.equal((owner.acpxVersion ?? "").length > 0, true);
  });
});

test("adding a permission policy rule key forces a queue protocol decision", () => {
  // Not a style check. A new rule key is invisible to every owner already
  // running, which is exactly how `defer` got auto-approved by v1 owners. If
  // this fails, decide the protocol question in src/cli/queue/lease-store.ts
  // before updating the count.
  assert.equal(
    PERMISSION_POLICY_RULE_KEYS.length,
    QUEUE_PROTOCOL_RULE_KEY_COUNT,
    "PERMISSION_POLICY_RULE_KEYS changed: decide queue compatibility, bump " +
      "QUEUE_PROTOCOL_VERSION, then update QUEUE_PROTOCOL_RULE_KEY_COUNT",
  );
});

test("a queue owner without parking refuses a --defer submit", async () => {
  await withTempHome(async (homeDir) => {
    await withFakeOwner(
      homeDir,
      "owner-no-parking",
      { queueProtocol: QUEUE_PROTOCOL_VERSION },
      async () => {
        await assertParkingRefusal(
          { sessionId: "owner-no-parking", defer: true, deferMaxAgeMs: 1_000 },
          /cannot park deferred requests/,
        );
        // A submit that does not ask for parking is unaffected.
        await assertReachesTransport({ sessionId: "owner-no-parking" });
      },
    );
  });
});

test("parking max-age is compared on effective values, not requested ones", async () => {
  await withTempHome(async (homeDir) => {
    // Owner seeded with an explicit 2s age.
    await withFakeOwner(
      homeDir,
      "owner-explicit-age",
      { queueProtocol: QUEUE_PROTOCOL_VERSION, parking: true, parkingMaxAgeMs: 2_000 },
      async () => {
        // Same age named explicitly: allowed.
        await assertReachesTransport({
          sessionId: "owner-explicit-age",
          defer: true,
          deferMaxAgeMs: 2_000,
        });
        // Different age: refused.
        await assertParkingRefusal(
          { sessionId: "owner-explicit-age", defer: true, deferMaxAgeMs: 5_000 },
          /expires parked requests after 2000 ms and cannot honour the requested 5000 ms/,
        );
        // Caller omits the flag, so it means the default — NOT "whatever the
        // owner happens to use". Silently inheriting 2s was the bug.
        await assertParkingRefusal(
          { sessionId: "owner-explicit-age", defer: true },
          new RegExp(`requested ${DEFAULT_DEFER_MAX_AGE_MS} ms`),
        );
      },
    );

    // Owner that fell back to the default must accept a caller naming it.
    await withFakeOwner(
      homeDir,
      "owner-default-age",
      {
        queueProtocol: QUEUE_PROTOCOL_VERSION,
        parking: true,
        parkingMaxAgeMs: DEFAULT_DEFER_MAX_AGE_MS,
      },
      async () => {
        await assertReachesTransport({
          sessionId: "owner-default-age",
          defer: true,
          deferMaxAgeMs: DEFAULT_DEFER_MAX_AGE_MS,
        });
        await assertReachesTransport({ sessionId: "owner-default-age", defer: true });
      },
    );
  });
});

test("a lease stamps effective parking metadata on acquire and on heartbeat", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-parking-stamp", {
      parking: true,
      parkingMaxAgeMs: 1_500,
    });
    assert(lease);
    assert.equal(lease.parking, true);
    assert.equal(lease.parkingMaxAgeMs, 1_500);

    const acquired = await readQueueOwnerRecord("owner-parking-stamp");
    assert.equal(acquired?.parking, true);
    assert.equal(acquired?.parkingMaxAgeMs, 1_500);

    // The heartbeat is the second writer and must not drop the capability.
    await refreshQueueOwnerLease(lease, { queueDepth: 3 });
    const refreshed = await readQueueOwnerRecord("owner-parking-stamp");
    assert.equal(refreshed?.parking, true);
    assert.equal(refreshed?.parkingMaxAgeMs, 1_500);
    assert.equal(refreshed?.queueDepth, 3);
  });
});

test("a lease without parking records no parking metadata", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-plain-stamp", {});
    assert(lease);
    const record = await readQueueOwnerRecord("owner-plain-stamp");
    assert.equal(record?.parking, undefined);
    assert.equal(record?.parkingMaxAgeMs, undefined);
  });
});
