import { spawn } from "node:child_process";
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
} from "node:net";
import { join } from "node:path";
import type { ResolvedConsoleConfig } from "./config.js";
import type { AcpxConsoleSessionService } from "./contracts.js";
import { startAcpxConsoleServer, type RunningAcpxConsoleServer } from "./server.js";

const RUNTIME_SCHEMA = "acpx.console.runtime.v1";
const DETACH_WAIT_MS = 10_000;
const STOP_WAIT_MS = 10_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

export interface ConsoleRuntimeRecord {
  schema: typeof RUNTIME_SCHEMA;
  pid: number;
  host: string;
  port: number;
  origin: string;
  startedAt: string;
  controlPath: string;
  healthHost: string;
}

export interface ConsoleLifecyclePaths {
  runtime: string;
  control: string;
  stdout: string;
  stderr: string;
}

export function lifecyclePaths(stateDir: string): ConsoleLifecyclePaths {
  const control =
    process.platform === "win32"
      ? `\\\\.\\pipe\\acpx-console-${Buffer.from(stateDir).toString("hex").slice(0, 24)}`
      : join(stateDir, "control.sock");
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
      typeof value.healthHost !== "string"
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
  if (record && isProcessAlive(record.pid)) {
    throw new Error(`ACPX Console is already running at ${record.origin} (pid ${record.pid})`);
  }
  await cleanStaleLifecycle(stateDir);
}

async function startControlServer(
  stateDir: string,
  stop: () => Promise<void>,
): Promise<{ server: NetServer; controlPath: string }> {
  const controlPath = lifecyclePaths(stateDir).control;
  if (process.platform !== "win32") {
    await rm(controlPath, { force: true });
  }
  const server = createNetServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (!input.includes("\n")) {
        return;
      }
      const command = input.slice(0, input.indexOf("\n")).trim();
      if (command !== "stop") {
        socket.end(`${JSON.stringify({ ok: false, error: "unknown command" })}\n`);
        return;
      }
      socket.end(`${JSON.stringify({ ok: true })}\n`);
      void stop();
    });
  });
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
  return { server, controlPath };
}

async function closeNetServer(server: NetServer): Promise<void> {
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
  let stopStarted: Promise<void> | undefined;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const stop = (): Promise<void> => {
    stopStarted ??= (async () => {
      try {
        if (control) {
          await closeNetServer(control);
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
    const controlResult = await startControlServer(config.stateDir, stop);
    control = controlResult.server;
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
    };
    await writeRuntimeRecord(config.stateDir, record);
    return { record, stopped, stop };
  } catch (error) {
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
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(record.controlPath);
    socket.setEncoding("utf8");
    socket.setTimeout(2_000);
    socket.once("connect", () => socket.write("stop\n"));
    socket.once("data", () => {
      socket.destroy();
      resolve();
    });
    socket.once("timeout", () => socket.destroy(new Error("Control socket timed out")));
    socket.once("error", reject);
  });
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
  child.unref();
}

export type { RunningAcpxConsoleServer };
