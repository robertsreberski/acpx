import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  ensureOwnerIsUsable,
  isProcessAlive,
  readLiveQueueOwner,
  readQueueOwnerRecord,
  readQueueOwnerStatus,
  refreshQueueOwnerLease,
  releaseQueueOwnerLease,
  terminateProcess,
  terminateQueueOwnerIfCurrent,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/lease-store.js";
import { queueBaseDir, queueLockFilePath, queueSocketBaseDir } from "../src/cli/queue/paths.js";
import {
  queuePaths,
  startKeeperProcess,
  stopProcess,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";

test("readQueueOwnerRecord returns undefined for missing and malformed lock files", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "missing-record";
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);

    const lockPath = queueLockFilePath(sessionId, homeDir);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "{not-json\n", "utf8");
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);

    await fs.writeFile(lockPath, `${JSON.stringify({ pid: "bad" })}\n`, "utf8");
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);
  });
});

test("tryAcquireQueueOwnerLease creates a lease that can be refreshed and released", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("lease-create");
    assert(lease);
    assert.equal(lease.sessionId, "lease-create");

    await refreshQueueOwnerLease(
      lease,
      {
        queueDepth: 1.7,
      },
      () => "2026-03-26T00:00:00.000Z",
    );

    const record = await readQueueOwnerRecord("lease-create");
    assert(record);
    assert.equal(record.queueDepth, 2);
    assert.equal(record.heartbeatAt, "2026-03-26T00:00:00.000Z");

    await releaseQueueOwnerLease(lease);
    assert.equal(await readQueueOwnerRecord("lease-create"), undefined);
  });
});

test("refreshQueueOwnerLease publishes complete records under concurrent reads", async () => {
  await withTempHome(async () => {
    const sessionId = "lease-atomic-refresh";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const writer = (async () => {
      for (let queueDepth = 0; queueDepth < 50; queueDepth += 1) {
        await refreshQueueOwnerLease(lease, { queueDepth });
      }
    })();
    const reader = (async () => {
      for (let read = 0; read < 100; read += 1) {
        const record = await readQueueOwnerRecord(sessionId);
        assert(record, "heartbeat publication must never expose a partial owner record");
        assert.equal(record.ownerGeneration, lease.ownerGeneration);
      }
    })();

    try {
      await Promise.all([writer, reader]);
    } finally {
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("releaseQueueOwnerLease waits for an in-flight atomic refresh", async () => {
  await withTempHome(async () => {
    const sessionId = "lease-release-refresh-race";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const originalRename = fs.rename;
    let signalRenameStarted: (() => void) | undefined;
    const renameStarted = new Promise<void>((resolve) => {
      signalRenameStarted = resolve;
    });
    let allowRename: (() => void) | undefined;
    const renameAllowed = new Promise<void>((resolve) => {
      allowRename = resolve;
    });
    fs.rename = async (oldPath, newPath) => {
      if (
        String(oldPath).startsWith(`${lease.lockPath}.`) &&
        String(oldPath).endsWith(".tmp") &&
        String(newPath) === lease.lockPath
      ) {
        signalRenameStarted?.();
        await renameAllowed;
      }
      await originalRename(oldPath, newPath);
    };

    try {
      const refresh = refreshQueueOwnerLease(lease, { queueDepth: 1 });
      await renameStarted;
      const release = releaseQueueOwnerLease(lease);
      allowRename?.();
      await Promise.all([refresh, release]);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
    } finally {
      allowRename?.();
      fs.rename = originalRename;
      await releaseQueueOwnerLease(lease).catch(() => undefined);
    }
  });
});

test("releaseQueueOwnerLease retries after a transient lock removal failure", async () => {
  await withTempHome(async () => {
    const sessionId = "lease-release-retry";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const originalRename = fs.rename;
    let failedOnce = false;
    fs.rename = async (oldPath, newPath) => {
      if (
        String(oldPath) === lease.lockPath &&
        String(newPath).startsWith(`${lease.lockPath}.retired.`) &&
        !failedOnce
      ) {
        failedOnce = true;
        const error = new Error("transient lock removal failure") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      await originalRename(oldPath, newPath);
    };

    try {
      await assert.rejects(releaseQueueOwnerLease(lease), /transient lock removal failure/);
      assert(await readQueueOwnerRecord(sessionId));
      await releaseQueueOwnerLease(lease);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
    } finally {
      fs.rename = originalRename;
      await releaseQueueOwnerLease(lease).catch(() => undefined);
    }
  });
});

test("releaseQueueOwnerLease preserves a replacement owner", async () => {
  await withTempHome(async () => {
    const sessionId = "lease-release-replacement";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const replacement = await startKeeperProcess();
    await writeQueueOwnerLock({
      lockPath: lease.lockPath,
      pid: replacement.pid,
      sessionId,
      socketPath: lease.socketPath,
      ownerGeneration: lease.ownerGeneration + 1,
    });

    try {
      await releaseQueueOwnerLease(lease);
      const current = await readQueueOwnerRecord(sessionId);
      assert.equal(current?.pid, replacement.pid);
      assert.equal(current?.ownerGeneration, lease.ownerGeneration + 1);
    } finally {
      await terminateQueueOwnerForSession(sessionId).catch(() => undefined);
      stopProcess(replacement);
    }
  });
});

test("tryAcquireQueueOwnerLease expires a retirement marker whose PID was reused", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "lease-stale-retirement-marker";
    const lockPath = queueLockFilePath(sessionId, homeDir);
    const markerPath = `${lockPath}.retiring`;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      `${JSON.stringify({
        markerId: "stale-marker-id",
        livenessPath: path.join(homeDir, "missing-retirement-liveness.sock"),
        pid: process.pid,
        ownerGeneration: 1,
        createdAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    await assert.rejects(fs.access(markerPath));
    await releaseQueueOwnerLease(lease);
  });
});

test("a live retirement marker does not expire while its creator is paused", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "lease-live-retirement-marker";
    const lockPath = queueLockFilePath(sessionId, homeDir);
    const markerPath = `${lockPath}.retiring`;
    const livenessPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\acpx-test-retire-${process.pid}-${Date.now()}`
        : path.join(homeDir, "live-retirement.sock");
    const livenessServer = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => livenessServer.listen(livenessPath, resolve));
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      `${JSON.stringify({
        markerId: "live-old-dated-marker",
        livenessPath,
        pid: process.pid,
        ownerGeneration: 1,
        createdAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const acquisition = tryAcquireQueueOwnerLease(sessionId);
    let settled = false;
    void acquisition.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(settled, false);
      await new Promise<void>((resolve) => livenessServer.close(() => resolve()));
      const lease = await acquisition;
      assert(lease);
      await releaseQueueOwnerLease(lease);
    } finally {
      if (livenessServer.listening) {
        await new Promise<void>((resolve) => livenessServer.close(() => resolve()));
      }
      if (process.platform !== "win32") {
        await fs.rm(livenessPath, { force: true });
      }
    }
  });
});

test("concurrent stale-marker cleanup preserves the winning replacement lease", async () => {
  if (process.platform === "win32") {
    return;
  }

  await withTempHome(async (homeDir) => {
    const sessionId = "lease-concurrent-stale-retirement-cleanup";
    const lockPath = queueLockFilePath(sessionId, homeDir);
    const markerPath = `${lockPath}.retiring`;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      `${JSON.stringify({
        markerId: "expired-shared-marker",
        livenessPath: path.join(homeDir, "missing-shared-marker-liveness.sock"),
        pid: process.pid,
        ownerGeneration: 1,
        createdAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const moduleUrl = pathToFileURL(path.resolve("dist-test/src/cli/queue/lease-store.js")).href;
    const childScript = `
      import {
        readQueueOwnerRecord,
        releaseQueueOwnerLease,
        tryAcquireQueueOwnerLease,
      } from ${JSON.stringify(moduleUrl)};
      process.stdout.write("ready\\n");
      await new Promise((resolve) => process.stdin.once("data", resolve));
      const lease = await tryAcquireQueueOwnerLease(${JSON.stringify(sessionId)});
      if (!lease) {
        process.stdout.write('{"acquired":false}\\n');
      } else {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const owner = await readQueueOwnerRecord(${JSON.stringify(sessionId)});
        process.stdout.write(JSON.stringify({
          acquired: true,
          leaseGeneration: lease.ownerGeneration,
          ownerGeneration: owner?.ownerGeneration,
          ownerPid: owner?.pid,
          processPid: process.pid,
          preserved: owner?.ownerGeneration === lease.ownerGeneration,
        }) + "\\n");
        await releaseQueueOwnerLease(lease);
      }
    `;
    const children = Array.from({ length: 2 }, () =>
      spawn(process.execPath, ["--input-type=module", "-e", childScript], {
        env: { ...process.env, HOME: homeDir },
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    const outputs = children.map((child) => {
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      return {
        child,
        ready: once(child.stdout, "data"),
        done: once(child, "close").then(() => output),
      };
    });

    try {
      await Promise.all(outputs.map((output) => output.ready));
      for (const output of outputs) {
        output.child.stdin.end("go\n");
      }
      const results = (await Promise.all(outputs.map((output) => output.done)))
        .flatMap((output) => output.trim().split("\n"))
        .filter((line) => line.startsWith("{"))
        .map(
          (line) =>
            JSON.parse(line) as {
              acquired: boolean;
              leaseGeneration?: number;
              ownerGeneration?: number;
              ownerPid?: number;
              processPid?: number;
              preserved?: boolean;
            },
        );
      assert.equal(results.filter((result) => result.acquired).length, 1);
      assert.equal(
        results.find((result) => result.acquired)?.preserved,
        true,
        JSON.stringify(results),
      );
      assert.equal(results.filter((result) => !result.acquired).length, 1);
    } finally {
      for (const output of outputs) {
        stopProcess(output.child);
      }
    }
  });
});

test("tryAcquireQueueOwnerLease persists MCP config path metadata", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("lease-mcp-config", {
      path: "/tmp/job-mcp.json",
      fingerprint: "fingerprint-v1",
    });
    assert(lease);
    assert.equal(lease.mcpConfigPath, "/tmp/job-mcp.json");
    assert.equal(lease.mcpConfigFingerprint, "fingerprint-v1");

    const record = await readQueueOwnerRecord("lease-mcp-config");
    assert(record);
    assert.equal(record.mcpConfigPath, "/tmp/job-mcp.json");
    assert.equal(record.mcpConfigFingerprint, "fingerprint-v1");

    await refreshQueueOwnerLease(lease, { queueDepth: 2 });
    const refreshed = await readQueueOwnerRecord("lease-mcp-config");
    assert(refreshed);
    assert.equal(refreshed.mcpConfigPath, "/tmp/job-mcp.json");
    assert.equal(refreshed.mcpConfigFingerprint, "fingerprint-v1");

    await releaseQueueOwnerLease(lease);
  });
});

test("tryAcquireQueueOwnerLease preserves the legacy clock callback argument", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease(
      "lease-clock-callback",
      () => "2026-03-26T00:00:00.000Z",
    );
    assert(lease);
    assert.equal(lease.createdAt, "2026-03-26T00:00:00.000Z");
    await releaseQueueOwnerLease(lease);
  });
});

test("tryAcquireQueueOwnerLease assigns collision-resistant owner generations", async () => {
  await withTempHome(async () => {
    const originalDateNow = Date.now;
    const originalMathRandom = Math.random;
    Date.now = () => 1_777_072_400_000;
    Math.random = () => 0;

    try {
      const first = await tryAcquireQueueOwnerLease("lease-generation-a");
      const second = await tryAcquireQueueOwnerLease("lease-generation-b");
      assert(first);
      assert(second);
      assert.notEqual(first.ownerGeneration, second.ownerGeneration);
      assert(Number.isSafeInteger(first.ownerGeneration));
      assert(Number.isSafeInteger(second.ownerGeneration));
      assert(first.ownerGeneration > 0);
      assert(second.ownerGeneration > 0);
      await releaseQueueOwnerLease(first);
      await releaseQueueOwnerLease(second);
    } finally {
      Date.now = originalDateNow;
      Math.random = originalMathRandom;
    }
  });
});

test("tryAcquireQueueOwnerLease tightens queue directory permissions", async () => {
  if (process.platform === "win32") {
    return;
  }

  await withTempHome(async (homeDir) => {
    const baseDir = queueBaseDir(homeDir);
    const socketDir = queueSocketBaseDir(homeDir);
    assert(socketDir);

    await fs.mkdir(baseDir, { recursive: true, mode: 0o777 });
    await fs.chmod(baseDir, 0o777);
    await fs.mkdir(socketDir, { recursive: true, mode: 0o777 });
    await fs.chmod(socketDir, 0o777);

    const lease = await tryAcquireQueueOwnerLease("lease-permissions");
    assert(lease);

    try {
      const baseMode = (await fs.stat(baseDir)).mode & 0o777;
      const socketMode = (await fs.stat(socketDir)).mode & 0o777;
      assert.equal(baseMode, 0o700);
      assert.equal(socketMode, 0o700);
    } finally {
      await releaseQueueOwnerLease(lease);
      await fs.rm(socketDir, { recursive: true, force: true });
    }
  });
});

test("tryAcquireQueueOwnerLease clears stale dead owners and can acquire on retry", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "stale-dead-owner";
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    await writeQueueOwnerLock({
      lockPath,
      pid: 999_999,
      sessionId,
      socketPath,
      heartbeatAt: "2000-01-01T00:00:00.000Z",
    });

    assert.equal(await tryAcquireQueueOwnerLease(sessionId), undefined);
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);

    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    await releaseQueueOwnerLease(lease);
  });
});

test("readQueueOwnerStatus returns live owner details for a healthy owner", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "healthy-owner";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
        queueDepth: 3,
      });

      const status = await readQueueOwnerStatus(sessionId);
      assert(status);
      assert.equal(status.pid, keeper.pid);
      assert.equal(status.alive, true);
      assert.equal(status.stale, false);
      assert.equal(status.queueDepth, 3);
    } finally {
      stopProcess(keeper);
      await fs.rm(lockPath, { force: true });
      if (process.platform !== "win32") {
        await fs.rm(socketPath, { force: true });
      }
    }
  });
});

test("ensureOwnerIsUsable cleans up stale live owners", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "stale-live-owner";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
      });

      const owner = await readQueueOwnerRecord(sessionId);
      assert(owner);
      assert.equal(await ensureOwnerIsUsable(sessionId, owner), false);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
      assert.equal(isProcessAlive(keeper.pid), false);
    } finally {
      stopProcess(keeper);
    }
  });
});

test("tryAcquireQueueOwnerLease terminates stale live owners before retry acquisition", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "stale-live-owner-acquire";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
      });

      assert.equal(await tryAcquireQueueOwnerLease(sessionId), undefined);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
      assert.equal(isProcessAlive(keeper.pid), false);

      const lease = await tryAcquireQueueOwnerLease(sessionId);
      assert(lease);
      await releaseQueueOwnerLease(lease);
    } finally {
      stopProcess(keeper);
    }
  });
});

test("terminateProcess and terminateQueueOwnerForSession handle live and missing owners", async () => {
  await withTempHome(async (homeDir) => {
    assert.equal(isProcessAlive(undefined), false);
    assert.equal(isProcessAlive(process.pid), false);
    assert.equal(await terminateProcess(999_999), false);

    const sessionId = "terminate-owner";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      assert.equal(isProcessAlive(keeper.pid), true);
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
      });

      await terminateQueueOwnerForSession(sessionId);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
    } finally {
      stopProcess(keeper);
    }
  });
});

test("terminateQueueOwnerForSession rejects a persistently unreadable owner record", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "terminate-unreadable-owner";
    const lockPath = queueLockFilePath(sessionId, homeDir);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "{", "utf8");

    await assert.rejects(terminateQueueOwnerForSession(sessionId), /Failed to read queue owner/);
    assert.equal(await fs.readFile(lockPath, "utf8"), "{");
  });
});

test("terminateQueueOwnerIfCurrent preserves a replacement owner", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "terminate-current-owner";
    const staleOwner = await startKeeperProcess();
    const replacementOwner = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      await writeQueueOwnerLock({
        lockPath,
        pid: staleOwner.pid,
        sessionId,
        socketPath,
        ownerGeneration: 11,
      });
      const expected = await readQueueOwnerRecord(sessionId);
      assert(expected);

      await writeQueueOwnerLock({
        lockPath,
        pid: replacementOwner.pid,
        sessionId,
        socketPath,
        ownerGeneration: 22,
      });

      assert.equal(await terminateQueueOwnerIfCurrent(sessionId, expected), "replaced");
      assert.equal(isProcessAlive(staleOwner.pid), true);
      assert.equal(isProcessAlive(replacementOwner.pid), true);
      const current = await readQueueOwnerRecord(sessionId);
      assert.equal(current?.pid, replacementOwner.pid);
      assert.equal(current?.ownerGeneration, 22);
    } finally {
      await terminateQueueOwnerForSession(sessionId).catch(() => {});
      stopProcess(staleOwner);
      stopProcess(replacementOwner);
    }
  });
});

test("terminateQueueOwnerIfCurrent preserves a legacy replacement at final removal", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "terminate-final-replacement-owner";
    const staleOwner = await startKeeperProcess();
    const replacementOwner = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: staleOwner.pid,
      sessionId,
      socketPath,
      ownerGeneration: 23,
    });
    const expected = await readQueueOwnerRecord(sessionId);
    assert(expected);
    const originalRename = fs.rename;
    let replacementPublished = false;
    fs.rename = async (oldPath, newPath) => {
      if (
        String(oldPath) === lockPath &&
        String(newPath).startsWith(`${lockPath}.retired.`) &&
        !replacementPublished
      ) {
        replacementPublished = true;
        await writeQueueOwnerLock({
          lockPath,
          pid: replacementOwner.pid,
          sessionId,
          socketPath,
          ownerGeneration: 24,
        });
      }
      await originalRename(oldPath, newPath);
    };

    try {
      assert.equal(await terminateQueueOwnerIfCurrent(sessionId, expected), "replaced");
      const current = await readQueueOwnerRecord(sessionId);
      assert.equal(current?.pid, replacementOwner.pid);
      assert.equal(current?.ownerGeneration, 24);
      assert.equal(isProcessAlive(replacementOwner.pid), true);
    } finally {
      fs.rename = originalRename;
      await terminateQueueOwnerForSession(sessionId).catch(() => undefined);
      stopProcess(staleOwner);
      stopProcess(replacementOwner);
    }
  });
});

test("terminateQueueOwnerForSession follows a replacement owner", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "terminate-session-replacement-owner";
    const staleOwner = await startKeeperProcess();
    const replacementOwner = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: staleOwner.pid,
      sessionId,
      socketPath,
      ownerGeneration: 25,
    });
    const originalRename = fs.rename;
    let replacementPublished = false;
    fs.rename = async (oldPath, newPath) => {
      if (
        String(oldPath) === lockPath &&
        String(newPath).startsWith(`${lockPath}.retired.`) &&
        !replacementPublished
      ) {
        replacementPublished = true;
        await writeQueueOwnerLock({
          lockPath,
          pid: replacementOwner.pid,
          sessionId,
          socketPath,
          ownerGeneration: 26,
        });
      }
      await originalRename(oldPath, newPath);
    };

    try {
      await terminateQueueOwnerForSession(sessionId);
      assert.equal(replacementPublished, true);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
      assert.equal(isProcessAlive(staleOwner.pid), false);
      assert.equal(isProcessAlive(replacementOwner.pid), false);
    } finally {
      fs.rename = originalRename;
      stopProcess(staleOwner);
      stopProcess(replacementOwner);
    }
  });
});

test("terminateQueueOwnerIfCurrent retries a transient unreadable owner record", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "terminate-transient-owner-record";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    const ownerGeneration = 27;
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
      ownerGeneration,
    });
    const expected = await readQueueOwnerRecord(sessionId);
    assert(expected);
    await fs.writeFile(lockPath, "{", "utf8");
    const restoreOwner = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
        ownerGeneration,
      });
    })();

    try {
      const retirement = terminateQueueOwnerIfCurrent(sessionId, expected);
      await restoreOwner;
      assert.equal(await retirement, "retired");
      assert.equal(isProcessAlive(keeper.pid), false);
    } finally {
      stopProcess(keeper);
      await fs.rm(lockPath, { force: true });
    }
  });
});

test("terminateQueueOwnerIfCurrent stops marker liveness when marker cleanup fails", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "terminate-marker-cleanup-failure";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
      ownerGeneration: 28,
    });
    const expected = await readQueueOwnerRecord(sessionId);
    assert(expected);
    const markerPath = `${lockPath}.retiring`;
    const originalRename = fs.rename;
    let failedCleanup = false;
    fs.rename = async (oldPath, newPath) => {
      if (String(oldPath) === markerPath && !isProcessAlive(keeper.pid) && !failedCleanup) {
        failedCleanup = true;
        throw new Error("marker cleanup failed");
      }
      await originalRename(oldPath, newPath);
    };

    try {
      await assert.rejects(
        terminateQueueOwnerIfCurrent(sessionId, expected),
        /marker cleanup failed/,
      );
      assert.equal(failedCleanup, true);
    } finally {
      fs.rename = originalRename;
      stopProcess(keeper);
    }

    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease, "stopped marker liveness must let acquisition clean the orphaned marker");
    await releaseQueueOwnerLease(lease);
  });
});

test("terminateQueueOwnerIfCurrent hands the lease to a waiting replacement atomically", async () => {
  if (process.platform === "win32") {
    return;
  }

  await withTempHome(async (homeDir) => {
    const sessionId = "terminate-owner-atomic-handoff";
    const retiringOwner = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => { process.stderr.write('terminating\\n'); " +
          "setTimeout(() => process.exit(0), 200); }); " +
          "process.stderr.write('ready\\n'); setInterval(() => {}, 60000);",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    await once(retiringOwner.stderr, "data");
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: retiringOwner.pid,
      sessionId,
      socketPath,
      ownerGeneration: 31,
    });
    const expected = await readQueueOwnerRecord(sessionId);
    assert(expected);

    try {
      const terminating = once(retiringOwner.stderr, "data");
      const retirement = terminateQueueOwnerIfCurrent(sessionId, expected);
      await terminating;
      const replacement = tryAcquireQueueOwnerLease(sessionId);

      assert.equal(await retirement, "retired");
      const replacementLease = await replacement;
      assert(replacementLease);
      const current = await readQueueOwnerRecord(sessionId);
      assert.equal(current?.ownerGeneration, replacementLease.ownerGeneration);
      await releaseQueueOwnerLease(replacementLease);
    } finally {
      stopProcess(retiringOwner);
    }
  });
});

test("terminateProcess waits long enough for a process that delays 2s before exiting on SIGTERM", async () => {
  // Regression test for the SIGTERM grace-period mismatch.
  //
  // A queue-owner's AcpClient.close() can take up to ~2 600 ms (stdin-close
  // 100 ms + SIGTERM wait 1 500 ms + SIGKILL wait 1 000 ms).  The old
  // PROCESS_EXIT_GRACE_MS of 1 500 ms would SIGKILL the owner before it
  // finished closing its bridge.  PROCESS_SIGTERM_GRACE_MS = 4 000 ms gives
  // sufficient headroom.
  //
  // This test spawns a Node.js process that defers its exit by 2 000 ms after
  // receiving SIGTERM and verifies that terminateProcess() returns true without
  // needing to escalate to SIGKILL (i.e. the process exits on its own within
  // the 4 s window).
  if (process.platform === "win32") {
    // SIGTERM semantics differ on Windows.
    return;
  }

  // The child writes "ready\n" to stderr once its SIGTERM handler is installed.
  // We wait for that line before sending SIGTERM to avoid the race where the
  // signal arrives before the handler is registered.
  const script = `
    process.on('SIGTERM', () => {
      setTimeout(() => process.exit(0), 2_000);
    });
    process.stderr.write('ready\\n');
    // Keep the event loop alive until SIGTERM arrives.
    setInterval(() => {}, 60_000);
  `;

  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  // Wait for the "ready" signal before sending SIGTERM.
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes("ready")) {
        child.stderr?.off("data", onData);
        resolve();
      }
    };
    child.stderr?.on("data", onData);
    child.once("exit", () => reject(new Error("child exited before signalling ready")));
  });

  assert(child.pid, "child must have a pid");

  try {
    assert.equal(isProcessAlive(child.pid), true, "child must be alive before terminateProcess");
    const result = await terminateProcess(child.pid);
    assert.equal(result, true, "terminateProcess must return true");
    assert.equal(isProcessAlive(child.pid), false, "process must be dead after terminateProcess");

    // Wait for the ChildProcess object to pick up the close event so that
    // exitCode / signalCode are populated.
    if (child.exitCode == null && child.signalCode == null) {
      await once(child, "close");
    }

    // The process should have exited with code 0 (clean exit via setTimeout),
    // not killed by a signal, proving the 4 s SIGTERM grace was enough.
    assert.equal(
      child.signalCode,
      null,
      `process should have exited cleanly, not via signal ${child.signalCode}`,
    );
    assert.equal(child.exitCode, 0, "process must exit with code 0");
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGKILL");
    }
  }
});

test("readLiveQueueOwner reports a live owner without retiring it", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "owner-alive-but-stale";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    try {
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
        ownerGeneration: 4242,
        // Older than the staleness window: a busy or suspended owner looks
        // exactly like this, and it is alive.
        heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      });

      const owner = await readLiveQueueOwner(sessionId);
      assert.equal(owner?.ownerGeneration, 4242);
      // The mutating read is what inspection paths must not use: it kills the
      // process and deletes its lease.
      assert.equal(keeper.exitCode, null);
      assert.equal(await fs.stat(lockPath).then(() => true), true);

      assert.equal(await readQueueOwnerStatus(sessionId), undefined);
      assert.equal(await waitForExit(keeper), true);
      assert.equal(
        await fs.stat(lockPath).then(
          () => true,
          () => false,
        ),
        false,
      );
    } finally {
      stopProcess(keeper);
    }
  });
});

test("readLiveQueueOwner treats a dead pid as no owner", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "owner-dead-pid";
    const keeper = await startKeeperProcess();
    const pid = keeper.pid;
    stopProcess(keeper);
    await waitForExit(keeper);
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({ lockPath, pid, sessionId, socketPath, ownerGeneration: 7 });

    assert.equal(await readLiveQueueOwner(sessionId), undefined);
  });
});

async function waitForExit(child: ReturnType<typeof spawn>): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
