import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open as openFile,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import {
  createConnection,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedConsoleConfig } from "./config.js";
import type { AcpxConsoleSessionService } from "./contracts.js";
import { startAcpxConsoleServer, type RunningAcpxConsoleServer } from "./server.js";

const RUNTIME_SCHEMA = "acpx.console.runtime.v1";
const DETACH_WAIT_MS = 10_000;
const STOP_WAIT_MS = 10_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const CONTROL_RESPONSE_MAX_BYTES = 4_096;
const CONTROL_REQUEST_MAX_BYTES = 4_096;
const CONTROL_TIMEOUT_MS = 2_000;

export interface ConsoleRuntimeRecord {
  schema: typeof RUNTIME_SCHEMA;
  pid: number;
  host: string;
  port: number;
  origin: string;
  startedAt: string;
  controlPath: string;
  healthHost: string;
  instanceToken: string;
}

export interface ConsoleLifecyclePaths {
  runtime: string;
  control: string;
  stdout: string;
  stderr: string;
}

export function lifecyclePaths(stateDir: string): ConsoleLifecyclePaths {
  const stateIdentity = createHash("sha256").update(resolve(stateDir)).digest("hex").slice(0, 24);
  const control =
    process.platform === "win32"
      ? `\\\\.\\pipe\\acpx-console-${stateIdentity}`
      : join(tmpdir(), `acpx-console-${stateIdentity}.sock`);
  return {
    runtime: join(stateDir, "runtime.json"),
    control,
    stdout: join(stateDir, "console.log"),
    stderr: join(stateDir, "console.error.log"),
  };
}

async function prepareStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(stateDir, 0o700);
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readRuntimeRecord(
  stateDir: string,
): Promise<ConsoleRuntimeRecord | undefined> {
  try {
    const runtimePath = lifecyclePaths(stateDir).runtime;
    const value: unknown = JSON.parse(await readFile(runtimePath, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("schema" in value) ||
      value.schema !== RUNTIME_SCHEMA ||
      !("pid" in value) ||
      typeof value.pid !== "number" ||
      !("controlPath" in value) ||
      typeof value.controlPath !== "string" ||
      !("healthHost" in value) ||
      typeof value.healthHost !== "string" ||
      !("instanceToken" in value) ||
      typeof value.instanceToken !== "string" ||
      value.instanceToken.length < 32
    ) {
      throw new Error(`ACPX Console runtime metadata is invalid: ${runtimePath}`);
    }
    return value as ConsoleRuntimeRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new Error(
        `ACPX Console runtime metadata is corrupt: ${lifecyclePaths(stateDir).runtime}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function writeRuntimeRecord(stateDir: string, record: ConsoleRuntimeRecord): Promise<void> {
  const paths = lifecyclePaths(stateDir);
  const temporary = `${paths.runtime}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, paths.runtime);
  if (process.platform !== "win32") {
    await chmod(paths.runtime, 0o600);
  }
}

async function cleanStaleLifecycle(stateDir: string): Promise<void> {
  const paths = lifecyclePaths(stateDir);
  await rm(paths.runtime, { force: true });
  if (process.platform !== "win32") {
    await rm(paths.control, { force: true });
  }
}

async function assertNoRunningConsole(stateDir: string): Promise<void> {
  const record = await readRuntimeRecord(stateDir);
  if (record && isProcessAlive(record.pid) && (await authenticateRuntime(record))) {
    throw new Error(`ACPX Console is already running at ${record.origin} (pid ${record.pid})`);
  }
  await cleanStaleLifecycle(stateDir);
}

async function startControlServer(
  stateDir: string,
  instanceToken: string,
  stop: () => Promise<void>,
): Promise<{ server: NetServer; controlPath: string; sockets: Set<Socket> }> {
  const controlPath = lifecyclePaths(stateDir).control;
  if (process.platform !== "win32") {
    await rm(controlPath, { force: true });
  }
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.setTimeout(CONTROL_TIMEOUT_MS, () => socket.destroy());
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input) > CONTROL_REQUEST_MAX_BYTES) {
        socket.end(`${JSON.stringify({ ok: false, error: "request too large" })}\n`);
        return;
      }
      if (!input.includes("\n")) {
        return;
      }
      let request: unknown;
      try {
        request = JSON.parse(input.slice(0, input.indexOf("\n")));
      } catch {
        socket.end(`${JSON.stringify({ ok: false, error: "invalid request" })}\n`);
        return;
      }
      if (
        typeof request !== "object" ||
        request === null ||
        !("instanceToken" in request) ||
        request.instanceToken !== instanceToken
      ) {
        socket.end(`${JSON.stringify({ ok: false, error: "instance authentication failed" })}\n`);
        return;
      }
      const command = "command" in request ? request.command : undefined;
      if (command === "status") {
        socket.end(`${JSON.stringify({ ok: true, pid: process.pid })}\n`);
        return;
      }
      if (command !== "stop") {
        socket.end(`${JSON.stringify({ ok: false, error: "unknown command" })}\n`);
        return;
      }
      socket.end(`${JSON.stringify({ ok: true })}\n`);
      setImmediate(() => void stop());
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(controlPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") {
      await chmod(controlPath, 0o600);
    }
    return { server, controlPath, sockets };
  } catch (error) {
    await closeNetServer(server, sockets).catch(() => undefined);
    if (process.platform !== "win32") {
      await rm(controlPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function closeNetServer(server: NetServer, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export interface ForegroundConsole {
  record: ConsoleRuntimeRecord;
  stopped: Promise<void>;
  stop(): Promise<void>;
}

export async function startForegroundConsole(
  config: ResolvedConsoleConfig,
  service: AcpxConsoleSessionService,
): Promise<ForegroundConsole> {
  await prepareStateDir(config.stateDir);
  await assertNoRunningConsole(config.stateDir);
  const running = await startAcpxConsoleServer({ config, service });
  let control: NetServer | undefined;
  let controlSockets = new Set<Socket>();
  let stopStarted: Promise<void> | undefined;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const stop = (): Promise<void> => {
    stopStarted ??= (async () => {
      try {
        if (control) {
          await closeNetServer(control, controlSockets);
        }
        await running.close();
      } finally {
        await cleanStaleLifecycle(config.stateDir);
        resolveStopped();
      }
    })();
    return stopStarted;
  };
  try {
    const instanceToken = randomBytes(32).toString("base64url");
    const controlResult = await startControlServer(config.stateDir, instanceToken, stop);
    control = controlResult.server;
    controlSockets = controlResult.sockets;
    const address = running.server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    const record: ConsoleRuntimeRecord = {
      schema: RUNTIME_SCHEMA,
      pid: process.pid,
      host: config.host,
      port,
      origin: running.origin,
      startedAt: new Date().toISOString(),
      controlPath: controlResult.controlPath,
      healthHost: config.allowedHosts[0],
      instanceToken,
    };
    await writeRuntimeRecord(config.stateDir, record);
    return { record, stopped, stop };
  } catch (error) {
    if (control) {
      await closeNetServer(control, controlSockets).catch(() => undefined);
    }
    await running.close();
    await cleanStaleLifecycle(config.stateDir);
    throw error;
  }
}

async function healthCheck(record: ConsoleRuntimeRecord): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const request = httpRequest(
      {
        host: record.host,
        port: record.port,
        path: "/healthz",
        method: "GET",
        headers: {
          Host: record.healthHost.includes(":") ? `[${record.healthHost}]` : record.healthHost,
        },
        timeout: 500,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
    request.end();
  });
}

async function controlRequest(
  record: ConsoleRuntimeRecord,
  command: "status" | "stop",
): Promise<{ ok: boolean; pid?: number; error?: string }> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(record.controlPath);
    socket.setEncoding("utf8");
    socket.setTimeout(CONTROL_TIMEOUT_MS);
    let response = "";
    let settled = false;
    const finish = (error?: Error, value?: { ok: boolean; pid?: number; error?: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(value ?? { ok: false });
      }
    };
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ command, instanceToken: record.instanceToken })}\n`),
    );
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > CONTROL_RESPONSE_MAX_BYTES) {
        finish(new Error("ACPX Console control response exceeded its size limit"));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) {
        return;
      }
      try {
        const value: unknown = JSON.parse(response.slice(0, newline));
        if (typeof value !== "object" || value === null || !("ok" in value)) {
          finish(new Error("ACPX Console control response was not valid"));
          return;
        }
        const result = value as { ok: unknown; pid?: unknown; error?: unknown };
        finish(undefined, {
          ok: result.ok === true,
          ...(typeof result.pid === "number" ? { pid: result.pid } : {}),
          ...(typeof result.error === "string" ? { error: result.error } : {}),
        });
      } catch (error) {
        finish(new Error("ACPX Console control response was not valid JSON", { cause: error }));
      }
    });
    socket.once("timeout", () => finish(new Error("ACPX Console control socket timed out")));
    socket.once("error", (error) => finish(error));
  });
}

async function authenticateRuntime(record: ConsoleRuntimeRecord): Promise<boolean> {
  try {
    const response = await controlRequest(record, "status");
    return response.ok && response.pid === record.pid;
  } catch {
    return false;
  }
}

export interface ConsoleStatus {
  status: "running" | "unreachable" | "stopped";
  record?: ConsoleRuntimeRecord;
}

export async function consoleStatus(stateDir: string): Promise<ConsoleStatus> {
  const record = await readRuntimeRecord(stateDir);
  if (!record) {
    return { status: "stopped" };
  }
  if (!isProcessAlive(record.pid)) {
    return { status: "stopped", record };
  }
  if (!(await authenticateRuntime(record))) {
    return { status: "stopped", record };
  }
  return { status: (await healthCheck(record)) ? "running" : "unreachable", record };
}

async function rotateLog(path: string): Promise<void> {
  try {
    if ((await stat(path)).size < LOG_ROTATE_BYTES) {
      return;
    }
    await rm(`${path}.1`, { force: true });
    await rename(path, `${path}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function startDetachedConsole(
  config: ResolvedConsoleConfig,
  childArguments: string[],
): Promise<ConsoleRuntimeRecord> {
  await prepareStateDir(config.stateDir);
  await assertNoRunningConsole(config.stateDir);
  const paths = lifecyclePaths(config.stateDir);
  await Promise.all([rotateLog(paths.stdout), rotateLog(paths.stderr)]);
  const stdoutHandle = await openFile(paths.stdout, "a", 0o600);
  const stderrHandle = await openFile(paths.stderr, "a", 0o600);
  try {
    const child = spawn(process.execPath, childArguments, {
      detached: true,
      stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
      env: process.env,
    });
    child.unref();
  } finally {
    await stdoutHandle.close();
    await stderrHandle.close();
  }
  const deadline = Date.now() + DETACH_WAIT_MS;
  while (Date.now() < deadline) {
    const status = await consoleStatus(config.stateDir);
    if (status.status === "running" && status.record) {
      return status.record;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Detached ACPX Console did not become healthy; inspect ${paths.stderr}`);
}

export async function stopDetachedConsole(
  stateDir: string,
): Promise<ConsoleRuntimeRecord | undefined> {
  const record = await readRuntimeRecord(stateDir);
  if (!record || !isProcessAlive(record.pid)) {
    await cleanStaleLifecycle(stateDir);
    return undefined;
  }
  const response = await controlRequest(record, "stop");
  if (!response.ok) {
    throw new Error(`ACPX Console stop failed: ${response.error ?? "control endpoint refused"}`);
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(record.pid)) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`ACPX Console pid ${record.pid} did not stop after the control request`);
}

export function attachShutdownSignals(foreground: ForegroundConsole): () => void {
  const handler = (): void => {
    void foreground.stop();
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

export async function openConsole(origin: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [origin]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", origin]]
        : ["xdg-open", [origin]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

export type { RunningAcpxConsoleServer };
