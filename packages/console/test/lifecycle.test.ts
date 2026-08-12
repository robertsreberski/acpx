import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResolvedConsoleConfig } from "../src/config.js";
import {
  consoleStatus,
  lifecyclePaths,
  readRuntimeRecord,
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
    const socket = createConnection(lifecyclePaths(config.stateDir).control);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write("stop\n"));
    socket.once("data", () => resolve());
    socket.once("error", reject);
  });
  await foreground.stopped;
  assert.equal(await readRuntimeRecord(config.stateDir), undefined);
});

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
