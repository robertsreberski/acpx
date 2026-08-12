import assert from "node:assert/strict";
import test from "node:test";
import { trySubmitToRunningOwner } from "../src/cli/queue/ipc.js";
import {
  QUEUE_PROTOCOL_RULE_KEY_COUNT,
  QUEUE_PROTOCOL_VERSION,
  queueOwnerProtocolVersion,
  readQueueOwnerRecord,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/lease-store.js";
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
}): Promise<unknown> {
  return await trySubmitToRunningOwner({
    sessionId: params.sessionId,
    message: "hello",
    permissionMode: "approve-all",
    ...(params.permissionPolicy ? { permissionPolicy: params.permissionPolicy } : {}),
    outputFormatter: noopFormatter(),
    waitForCompletion: true,
  });
}

/**
 * Stand up a live-looking owner lease whose recorded protocol version we
 * control. The pid belongs to a real idle process so the owner passes the
 * liveness and heartbeat checks and the request reaches the protocol gate.
 */
async function withFakeOwner(
  homeDir: string,
  sessionId: string,
  fields: { queueProtocol?: number; acpxVersion?: string },
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
      ...fields,
    });
    await run();
  } finally {
    stopProcess(keeper);
  }
}

const DEFER_POLICY: PermissionPolicy = { defer: ["execute"] };

test("a pre-defer queue owner refuses a policy carrying defer rules", async () => {
  await withTempHome(async (homeDir) => {
    // No queueProtocol field at all: exactly what an owner from a build that
    // predates defer leaves on disk.
    await withFakeOwner(homeDir, "owner-legacy-defer", { acpxVersion: "0.13.0" }, async () => {
      const owner = await readQueueOwnerRecord("owner-legacy-defer");
      assert(owner);
      assert.equal(owner.queueProtocol, undefined);
      assert.equal(queueOwnerProtocolVersion(owner), 1);

      await assert.rejects(
        async () =>
          await submitWithPolicy({
            sessionId: "owner-legacy-defer",
            permissionPolicy: DEFER_POLICY,
          }),
        (error: unknown) => {
          assert.equal(error instanceof QueueConnectionError, true);
          const queueError = error as QueueConnectionError;
          assert.equal(queueError.detailCode, "QUEUE_OWNER_PROTOCOL_MISMATCH");
          assert.equal(queueError.retryable, false);
          assert.match(queueError.message, /queue protocol v1/);
          assert.match(queueError.message, /owner acpx 0\.13\.0/);
          return true;
        },
      );
    });
  });
});

test("a pre-defer queue owner refuses defaultAction defer", async () => {
  await withTempHome(async (homeDir) => {
    await withFakeOwner(homeDir, "owner-legacy-default", {}, async () => {
      await assert.rejects(
        async () =>
          await submitWithPolicy({
            sessionId: "owner-legacy-default",
            permissionPolicy: { defaultAction: "defer" },
          }),
        (error: unknown) =>
          (error as QueueConnectionError).detailCode === "QUEUE_OWNER_PROTOCOL_MISMATCH",
      );
    });
  });
});

/**
 * Passing the gate means the request reached the transport. These leases have no
 * socket behind them, so the transport failure (QUEUE_NOT_ACCEPTING_REQUESTS) is
 * the signal that gating let the request through.
 */
async function assertReachesTransport(params: {
  sessionId: string;
  permissionPolicy?: PermissionPolicy;
}): Promise<void> {
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

test("a pre-defer queue owner still serves policies that do not use defer", async () => {
  await withTempHome(async (homeDir) => {
    await withFakeOwner(homeDir, "owner-legacy-compatible", {}, async () => {
      // Gating every warm owner on upgrade would be a regression, so a policy a
      // v1 owner handles identically must pass.
      for (const permissionPolicy of [
        undefined,
        { escalate: ["execute"] } as PermissionPolicy,
        { defer: [], defaultAction: "deny" } as PermissionPolicy,
      ]) {
        await assertReachesTransport({
          sessionId: "owner-legacy-compatible",
          ...(permissionPolicy ? { permissionPolicy } : {}),
        });
      }
    });
  });
});

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
    "PERMISSION_POLICY_RULE_KEYS changed: teach permissionPolicyNeedsDeferSupport about the " +
      "new key, bump QUEUE_PROTOCOL_VERSION, then update QUEUE_PROTOCOL_RULE_KEY_COUNT",
  );
});
