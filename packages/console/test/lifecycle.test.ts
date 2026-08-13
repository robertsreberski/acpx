import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResolvedConsoleConfig } from "../src/config.js";
import {
  consoleStatus,
  lifecyclePaths,
  openConsole,
  readRuntimeRecord,
  startDetachedConsole,
  startForegroundConsole,
  stopDetachedConsole,
} from "../src/lifecycle.js";
import { MockSessionService } from "./helpers.js";

test("foreground lifecycle writes private control state and stops without an HTTP shutdown route", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-lifecycle-"));
  const web = join(root, "web");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "ok");
  const config: ResolvedConsoleConfig = {
    host: "127.0.0.1",
    port: 0,
    trustNetwork: false,
    allowedHosts: ["127.0.0.1"],
    workspaceRoots: [root],
    stateDir: join(root, "state"),
    staticDir: web,
  };
  const foreground = await startForegroundConsole(config, new MockSessionService());
  assert.deepEqual(await consoleStatus(config.stateDir), {
    status: "running",
    record: foreground.record,
  });
  assert.equal((await readRuntimeRecord(config.stateDir))?.pid, process.pid);
  assert.equal(foreground.record.healthHost, "127.0.0.1");
  const shutdownRoute = await fetch(`${foreground.record.origin}/shutdown`);
  assert.equal(shutdownRoute.status, 200);

  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(foreground.record.controlPath);
    socket.setEncoding("utf8");
    socket.once("connect", () =>
      socket.write(
        `${JSON.stringify({ command: "stop", instanceToken: foreground.record.instanceToken })}\n`,
      ),
    );
    socket.once("data", () => resolve());
    socket.once("error", reject);
  });
  await foreground.stopped;
  assert.equal(await readRuntimeRecord(config.stateDir), undefined);
});

test("foreground shutdown destroys partial control clients instead of hanging", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-control-partial-"));
  const web = join(root, "web");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "ok");
  const config: ResolvedConsoleConfig = {
    host: "127.0.0.1",
    port: 0,
    trustNetwork: false,
    allowedHosts: ["127.0.0.1"],
    workspaceRoots: [root],
    stateDir: join(root, "state"),
    staticDir: web,
  };
  const foreground = await startForegroundConsole(config, new MockSessionService());
  const socket = createConnection(foreground.record.controlPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write("partial-without-newline");
  await Promise.race([
    foreground.stop(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("foreground shutdown hung on control client")), 1_000),
    ),
  ]);
  assert.equal(socket.destroyed, true);
});

test("control socket paths remain bounded for arbitrarily long state directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-long-state-"));
  const web = join(root, "web");
  const stateDir = join(root, "a".repeat(90), "b".repeat(90), "state");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "ok");
  const foreground = await startForegroundConsole(
    {
      host: "127.0.0.1",
      port: 0,
      trustNetwork: false,
      allowedHosts: ["127.0.0.1"],
      workspaceRoots: [root],
      stateDir,
      staticDir: web,
    },
    new MockSessionService(),
  );
  try {
    assert.ok(foreground.record.controlPath.length < 100);
    assert.equal((await consoleStatus(stateDir)).status, "running");
  } finally {
    await foreground.stop();
  }
});

test("a live but unverifiable runtime is unreachable and cannot be replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-stale-pid-"));
  const web = join(root, "web");
  const stateDir = join(root, "state");
  await Promise.all([mkdir(web), mkdir(stateDir)]);
  await writeFile(join(web, "index.html"), "ok");
  await writeFile(
    lifecyclePaths(stateDir).runtime,
    JSON.stringify({
      schema: "acpx.console.runtime.v1",
      pid: process.pid,
      host: "127.0.0.1",
      port: 9,
      origin: "http://127.0.0.1:9",
      startedAt: new Date().toISOString(),
      controlPath: lifecyclePaths(stateDir).control,
      healthHost: "127.0.0.1",
      instanceToken: "stale-instance-token-00000000000000",
    }),
  );
  const config = {
    host: "127.0.0.1",
    port: 0,
    trustNetwork: false,
    allowedHosts: ["127.0.0.1"],
    workspaceRoots: [root],
    stateDir,
    staticDir: web,
  } satisfies ResolvedConsoleConfig;
  assert.equal((await consoleStatus(stateDir, { controlTimeoutMs: 25 })).status, "unreachable");
  const before = await readFile(lifecyclePaths(stateDir).runtime, "utf8");
  await assert.rejects(
    startForegroundConsole(config, new MockSessionService()),
    /live but unreachable process/,
  );
  assert.equal(await readFile(lifecyclePaths(stateDir).runtime, "utf8"), before);
});

test("one concurrent foreground start atomically owns the state directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-concurrent-start-"));
  const web = join(root, "web");
  const stateDir = join(root, "state");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "ok");
  const config = {
    host: "127.0.0.1",
    port: 0,
    trustNetwork: false,
    allowedHosts: ["127.0.0.1"],
    workspaceRoots: [root],
    stateDir,
    staticDir: web,
  } satisfies ResolvedConsoleConfig;
  const results = await Promise.allSettled([
    startForegroundConsole(config, new MockSessionService()),
    startForegroundConsole(config, new MockSessionService()),
  ]);
  const started = results.filter(
    (
      result,
    ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof startForegroundConsole>>> =>
      result.status === "fulfilled",
  );
  try {
    assert.equal(started.length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.match(
      String(
        (results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
      ),
      /already claimed|belongs to a live/,
    );
    await access(started[0].value.record.controlPath);
    assert.equal((await consoleStatus(stateDir)).status, "running");
  } finally {
    await started[0]?.value.stop();
  }
});

test("concurrent contenders serialize reclamation of a dead startup claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-dead-claim-race-"));
  const web = join(root, "web");
  const stateDir = join(root, "state");
  await Promise.all([mkdir(web), mkdir(stateDir)]);
  await writeFile(join(web, "index.html"), "ok");
  await writeFile(
    lifecyclePaths(stateDir).claim,
    JSON.stringify({
      schema: "acpx.console.claim.v1",
      pid: 2_147_483_647,
      instanceToken: "dead-claim-instance-token-000000000000",
    }),
  );
  const config = {
    host: "127.0.0.1",
    port: 0,
    trustNetwork: false,
    allowedHosts: ["127.0.0.1"],
    workspaceRoots: [root],
    stateDir,
    staticDir: web,
  } satisfies ResolvedConsoleConfig;
  const results = await Promise.allSettled([
    startForegroundConsole(config, new MockSessionService()),
    startForegroundConsole(config, new MockSessionService()),
  ]);
  const started = results.find(
    (
      result,
    ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof startForegroundConsole>>> =>
      result.status === "fulfilled",
  );
  try {
    assert.ok(started);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    await assert.rejects(access(lifecyclePaths(stateDir).claimGuard));
    assert.equal((await consoleStatus(stateDir)).status, "running");
  } finally {
    await started?.value.stop();
  }
});

test("an interrupted claim guard fails closed with an actionable recovery path", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-dead-claim-guard-"));
  const web = join(root, "web");
  const stateDir = join(root, "state");
  await Promise.all([mkdir(web), mkdir(stateDir)]);
  await writeFile(join(web, "index.html"), "ok");
  const paths = lifecyclePaths(stateDir);
  await writeFile(
    paths.claimGuard,
    JSON.stringify({
      schema: "acpx.console.claim.v1",
      pid: 2_147_483_647,
      instanceToken: "dead-guard-instance-token-000000000000",
    }),
  );
  await assert.rejects(
    startForegroundConsole(
      {
        host: "127.0.0.1",
        port: 0,
        trustNetwork: false,
        allowedHosts: ["127.0.0.1"],
        workspaceRoots: [root],
        stateDir,
        staticDir: web,
      },
      new MockSessionService(),
    ),
    new RegExp(
      `claim recovery was interrupted.*${paths.claimGuard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
  );
  await access(paths.claimGuard);
});

test("a live mismatched claim makes dead runtime metadata unreachable", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-mismatched-claim-"));
  const stateDir = join(root, "state");
  const paths = lifecyclePaths(stateDir);
  await mkdir(stateDir);
  await writeFile(
    paths.runtime,
    JSON.stringify({
      schema: "acpx.console.runtime.v1",
      pid: 2_147_483_647,
      host: "127.0.0.1",
      port: 4174,
      origin: "http://127.0.0.1:4174",
      startedAt: new Date().toISOString(),
      controlPath: paths.control,
      healthHost: "127.0.0.1",
      instanceToken: "dead-runtime-instance-token-00000000000",
    }),
  );
  await writeFile(
    paths.claim,
    JSON.stringify({
      schema: "acpx.console.claim.v1",
      pid: process.pid,
      instanceToken: "live-claim-instance-token-000000000000",
    }),
  );
  assert.equal((await consoleStatus(stateDir)).status, "unreachable");
  await assert.rejects(stopDetachedConsole(stateDir), /starting or unreachable/);
  await access(paths.runtime);
  await access(paths.claim);
});

test(
  "restart reclaims a dead instance's control socket without touching live endpoints",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "acpx-console-killed-control-"));
    const web = join(root, "web");
    const stateDir = join(root, "state");
    await Promise.all([mkdir(web), mkdir(stateDir)]);
    await writeFile(join(web, "index.html"), "ok");
    const paths = lifecyclePaths(stateDir);
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const n=require('node:net');const s=n.createServer();s.listen(process.argv[1],()=>process.stdout.write('ready\\n'))",
        paths.control,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await access(paths.control);
    const token = "killed-instance-token-0000000000000000";
    await writeFile(
      paths.runtime,
      JSON.stringify({
        schema: "acpx.console.runtime.v1",
        pid: child.pid,
        host: "127.0.0.1",
        port: 4174,
        origin: "http://127.0.0.1:4174",
        startedAt: new Date().toISOString(),
        controlPath: paths.control,
        healthHost: "127.0.0.1",
        instanceToken: token,
      }),
    );
    await writeFile(
      paths.claim,
      JSON.stringify({
        schema: "acpx.console.claim.v1",
        pid: child.pid,
        instanceToken: token,
      }),
    );
    const foreground = await startForegroundConsole(
      {
        host: "127.0.0.1",
        port: 0,
        trustNetwork: false,
        allowedHosts: ["127.0.0.1"],
        workspaceRoots: [root],
        stateDir,
        staticDir: web,
      },
      new MockSessionService(),
    );
    try {
      await assert.rejects(access(paths.control));
      await access(foreground.record.controlPath);
    } finally {
      await foreground.stop();
    }
  },
);

test("corrupt runtime metadata fails closed without deleting the control endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-corrupt-"));
  const stateDir = join(root, "state");
  const paths = lifecyclePaths(stateDir);
  await mkdir(stateDir);
  await writeFile(paths.runtime, "{partially-written", "utf8");
  await writeFile(paths.control, "sentinel", "utf8");
  await assert.rejects(readRuntimeRecord(stateDir), /runtime metadata is corrupt/);
  assert.equal(await readFile(paths.control, "utf8"), "sentinel");
});

test("stop requires one bounded newline-delimited success response", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-control-"));
  const stateDir = join(root, "state");
  const paths = lifecyclePaths(stateDir);
  await mkdir(stateDir);
  const control = createNetServer((socket) => {
    socket.once("data", () => {
      socket.write('{"ok":false,"error":"refused"}');
      socket.end("\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    control.once("error", reject);
    control.listen(paths.control, resolve);
  });
  await writeFile(
    paths.runtime,
    JSON.stringify({
      schema: "acpx.console.runtime.v1",
      pid: process.pid,
      host: "127.0.0.1",
      port: 4174,
      origin: "http://127.0.0.1:4174",
      startedAt: new Date().toISOString(),
      controlPath: paths.control,
      healthHost: "127.0.0.1",
      instanceToken: "test-instance-token-00000000000000",
    }),
  );
  try {
    await assert.rejects(stopDetachedConsole(stateDir), /stop failed: refused/);
    assert.ok(await readRuntimeRecord(stateDir));
  } finally {
    await new Promise<void>((resolve, reject) =>
      control.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("stop rejects an oversized control response before waiting for process exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-control-large-"));
  const stateDir = join(root, "state");
  const paths = lifecyclePaths(stateDir);
  await mkdir(stateDir);
  const control = createNetServer((socket) => {
    socket.once("data", () => socket.end("x".repeat(5_000)));
  });
  await new Promise<void>((resolve, reject) => {
    control.once("error", reject);
    control.listen(paths.control, resolve);
  });
  await writeFile(
    paths.runtime,
    JSON.stringify({
      schema: "acpx.console.runtime.v1",
      pid: process.pid,
      host: "127.0.0.1",
      port: 4174,
      origin: "http://127.0.0.1:4174",
      startedAt: new Date().toISOString(),
      controlPath: paths.control,
      healthHost: "127.0.0.1",
      instanceToken: "test-instance-token-00000000000000",
    }),
  );
  try {
    await assert.rejects(stopDetachedConsole(stateDir), /exceeded its size limit/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      control.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("control timeouts report unreachable and preserve another instance's files", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-control-timeout-"));
  const stateDir = join(root, "state");
  const paths = lifecyclePaths(stateDir);
  await mkdir(stateDir);
  const sockets = new Set<import("node:net").Socket>();
  const control = createNetServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    control.once("error", reject);
    control.listen(paths.control, resolve);
  });
  const runtime = JSON.stringify({
    schema: "acpx.console.runtime.v1",
    pid: process.pid,
    host: "127.0.0.1",
    port: 4174,
    origin: "http://127.0.0.1:4174",
    startedAt: new Date().toISOString(),
    controlPath: paths.control,
    healthHost: "127.0.0.1",
    instanceToken: "unreachable-instance-token-00000000000",
  });
  await writeFile(paths.runtime, runtime);
  try {
    assert.deepEqual(await consoleStatus(stateDir, { controlTimeoutMs: 25 }), {
      status: "unreachable",
      record: JSON.parse(runtime),
    });
    await assert.rejects(
      stopDetachedConsole(stateDir, { controlTimeoutMs: 25 }),
      /control socket timed out/,
    );
    assert.equal(await readFile(paths.runtime, "utf8"), runtime);
    await access(paths.control);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) =>
      control.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("foreground startup closes its control server when runtime metadata cannot be committed", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-runtime-write-failure-"));
  const web = join(root, "web");
  const stateDir = join(root, "state");
  await Promise.all([mkdir(web), mkdir(stateDir)]);
  await writeFile(join(web, "index.html"), "ok");
  await mkdir(join(stateDir, `runtime.json.${process.pid}.tmp`));

  await assert.rejects(
    startForegroundConsole(
      {
        host: "127.0.0.1",
        port: 0,
        trustNetwork: false,
        allowedHosts: ["127.0.0.1"],
        workspaceRoots: [root],
        stateDir,
        staticDir: web,
      },
      new MockSessionService(),
    ),
    /EISDIR|illegal operation on a directory/,
  );
  await assert.rejects(access(lifecyclePaths(stateDir).control));
});

test("foreground server startup failure releases its claim so the state directory can retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-server-start-failure-"));
  const web = join(root, "web");
  const stateDir = join(root, "state");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "ok");
  const occupied = createNetServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  const address = occupied.address();
  assert.ok(address && typeof address === "object");
  const baseConfig = {
    host: "127.0.0.1",
    trustNetwork: false,
    allowedHosts: ["127.0.0.1"],
    workspaceRoots: [root],
    stateDir,
    staticDir: web,
  } satisfies Omit<ResolvedConsoleConfig, "port">;
  try {
    await assert.rejects(
      startForegroundConsole({ ...baseConfig, port: address.port }, new MockSessionService()),
      /EADDRINUSE/,
    );
    await assert.rejects(access(lifecyclePaths(stateDir).claim));
  } finally {
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve())),
    );
  }
  const retry = await startForegroundConsole({ ...baseConfig, port: 0 }, new MockSessionService());
  await retry.stop();
});

test("opening the console rejects when the platform browser launcher cannot spawn", async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await assert.rejects(openConsole("http://127.0.0.1:4174"), /ENOENT/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("foreground stopped settles even when lifecycle metadata cleanup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-stop-cleanup-failure-"));
  const web = join(root, "web");
  const stateDir = join(root, "state");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "ok");
  const foreground = await startForegroundConsole(
    {
      host: "127.0.0.1",
      port: 0,
      trustNetwork: false,
      allowedHosts: ["127.0.0.1"],
      workspaceRoots: [root],
      stateDir,
      staticDir: web,
    },
    new MockSessionService(),
  );
  const runtimePath = lifecyclePaths(stateDir).runtime;
  await rm(runtimePath);
  await mkdir(runtimePath);
  try {
    const [stopResult, stoppedResult] = await Promise.allSettled([
      foreground.stop(),
      foreground.stopped,
    ]);
    assert.equal(stopResult.status, "rejected");
    assert.match(String(stopResult.reason.code), /EISDIR|EPERM/);
    assert.equal(stoppedResult.status, "fulfilled");
    await access(lifecyclePaths(stateDir).claim);
  } finally {
    await rm(runtimePath, { recursive: true, force: true });
  }
});

test("shutdown retains ownership when service disposal fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-dispose-failure-"));
  const web = join(root, "web");
  const stateDir = join(root, "state");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "ok");
  const service = new MockSessionService();
  service.dispose = () => {
    throw new Error("dispose failed");
  };
  const foreground = await startForegroundConsole(
    {
      host: "127.0.0.1",
      port: 0,
      trustNetwork: false,
      allowedHosts: ["127.0.0.1"],
      workspaceRoots: [root],
      stateDir,
      staticDir: web,
    },
    service,
  );
  await assert.rejects(foreground.stop(), /dispose failed/);
  await access(lifecyclePaths(stateDir).runtime);
  await access(lifecyclePaths(stateDir).claim);
});

test("detached startup fails promptly when its exact child exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-detached-exit-"));
  const stateDir = join(root, "state");
  const startedAt = Date.now();
  await assert.rejects(
    startDetachedConsole(
      {
        host: "127.0.0.1",
        port: 0,
        trustNetwork: false,
        allowedHosts: ["127.0.0.1"],
        workspaceRoots: [root],
        stateDir,
        staticDir: join(root, "web"),
      },
      ["-e", "process.exit(7)"],
    ),
    /exited before becoming healthy/,
  );
  assert.ok(Date.now() - startedAt < 2_000);
});
