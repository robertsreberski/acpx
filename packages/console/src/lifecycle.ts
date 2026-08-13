import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  link,
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
import { isWildcardHost, type ResolvedConsoleConfig } from "./config.js";
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
  claim: string;
  claimGuard: string;
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
    claim: join(stateDir, "runtime.claim"),
    claimGuard: join(stateDir, "runtime.claim.guard"),
    control,
    stdout: join(stateDir, "console.log"),
    stderr: join(stateDir, "console.error.log"),
  };
}

interface ConsoleRuntimeClaim {
  schema: "acpx.console.claim.v1";
  pid: number;
  instanceToken: string;
}

function instanceControlPath(stateDir: string, instanceToken: string): string {
  const stateIdentity = createHash("sha256").update(resolve(stateDir)).digest("hex").slice(0, 12);
  const instanceIdentity = createHash("sha256").update(instanceToken).digest("hex").slice(0, 12);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\acpx-console-${stateIdentity}-${instanceIdentity}`
    : join(tmpdir(), `acpx-console-${stateIdentity}-${instanceIdentity}.sock`);
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

async function readRuntimeClaim(stateDir: string): Promise<ConsoleRuntimeClaim | undefined> {
  const path = lifecyclePaths(stateDir).claim;
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("schema" in value) ||
      value.schema !== "acpx.console.claim.v1" ||
      !("pid" in value) ||
      typeof value.pid !== "number" ||
      !("instanceToken" in value) ||
      typeof value.instanceToken !== "string" ||
      value.instanceToken.length < 32
    ) {
      throw new Error(`ACPX Console runtime claim is invalid: ${path}`);
    }
    return value as ConsoleRuntimeClaim;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`ACPX Console runtime claim is corrupt: ${path}`, { cause: error });
    }
    throw error;
  }
}

async function removeOwnedClaim(stateDir: string, instanceToken: string): Promise<boolean> {
  const claim = await readRuntimeClaim(stateDir);
  if (!claim || claim.instanceToken !== instanceToken) {
    return false;
  }
  await rm(lifecyclePaths(stateDir).claim, { force: true });
  return true;
}

async function acquireRuntimeClaim(
  stateDir: string,
  instanceToken: string,
): Promise<ConsoleRuntimeClaim> {
  const paths = lifecyclePaths(stateDir);
  const claim: ConsoleRuntimeClaim = {
    schema: "acpx.console.claim.v1",
    pid: process.pid,
    instanceToken,
  };
  const temporary = `${paths.claim}.${process.pid}.${instanceToken}.tmp`;
  await writeFile(temporary, `${JSON.stringify(claim)}\n`, { mode: 0o600 });
  try {
    const guardDeadline = Date.now() + CONTROL_TIMEOUT_MS;
    for (;;) {
      try {
        await link(temporary, paths.claimGuard);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        let guard: ConsoleRuntimeClaim;
        try {
          const value: unknown = JSON.parse(await readFile(paths.claimGuard, "utf8"));
          guard = value as ConsoleRuntimeClaim;
          if (
            guard.schema !== "acpx.console.claim.v1" ||
            typeof guard.pid !== "number" ||
            typeof guard.instanceToken !== "string" ||
            guard.instanceToken.length < 32
          ) {
            throw new Error(`ACPX Console claim guard is invalid: ${paths.claimGuard}`, {
              cause: error,
            });
          }
        } catch (guardError) {
          if ((guardError as NodeJS.ErrnoException).code === "ENOENT") {
            continue;
          }
          throw guardError;
        }
        if (!isProcessAlive(guard.pid)) {
          throw new Error(
            `ACPX Console claim recovery was interrupted by dead pid ${guard.pid}; remove ${paths.claimGuard} after verifying no startup is active`,
            { cause: error },
          );
        }
        if (Date.now() >= guardDeadline) {
          throw new Error("Timed out waiting for another ACPX Console startup claim", {
            cause: error,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    try {
      const owner = await readRuntimeClaim(stateDir);
      if (owner && isProcessAlive(owner.pid)) {
        throw new Error(
          `ACPX Console state is already claimed by a live process (pid ${owner.pid})`,
        );
      }
      if (owner) {
        await rm(paths.claim, { force: true });
      }
      await link(temporary, paths.claim);
      return claim;
    } finally {
      const guard = await readFile(paths.claimGuard, "utf8").catch(() => undefined);
      if (guard === `${JSON.stringify(claim)}\n`) {
        await rm(paths.claimGuard, { force: true });
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeStaleControlEndpoint(
  stateDir: string,
  record: ConsoleRuntimeRecord,
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const expectedPaths = new Set([
    lifecyclePaths(stateDir).control,
    instanceControlPath(stateDir, record.instanceToken),
  ]);
  if (expectedPaths.has(record.controlPath)) {
    await rm(record.controlPath, { force: true });
  }
}

async function removeOwnedRuntime(stateDir: string, instanceToken: string): Promise<void> {
  const paths = lifecyclePaths(stateDir);
  const record = await readRuntimeRecord(stateDir);
  if (record?.instanceToken === instanceToken) {
    await rm(paths.runtime, { force: true });
  }
}

async function claimConsoleLifecycle(
  stateDir: string,
  instanceToken: string,
): Promise<ConsoleRuntimeClaim> {
  const record = await readRuntimeRecord(stateDir);
  if (record && isProcessAlive(record.pid)) {
    throw new Error(
      `ACPX Console state belongs to a live${(await authenticateRuntime(record)) ? "" : " but unreachable"} process at ${record.origin} (pid ${record.pid})`,
    );
  }
  const claim = await acquireRuntimeClaim(stateDir, instanceToken);
  try {
    const current = await readRuntimeRecord(stateDir);
    if (current && isProcessAlive(current.pid)) {
      throw new Error(
        `ACPX Console state belongs to a live process at ${current.origin} (pid ${current.pid})`,
      );
    }
    if (current) {
      await removeStaleControlEndpoint(stateDir, current);
      await rm(lifecyclePaths(stateDir).runtime, { force: true });
    }
    return claim;
  } catch (error) {
    await removeOwnedClaim(stateDir, instanceToken).catch(() => undefined);
    throw error;
  }
}

async function startControlServer(
  stateDir: string,
  instanceToken: string,
  stop: () => Promise<void>,
): Promise<{ server: NetServer; controlPath: string; sockets: Set<Socket> }> {
  const controlPath = instanceControlPath(stateDir, instanceToken);
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
      setImmediate(() => {
        void stop().catch((error: unknown) => {
          console.error(
            `ACPX Console shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exitCode = 1;
        });
      });
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
  const instanceToken = randomBytes(32).toString("base64url");
  try {
    await claimConsoleLifecycle(config.stateDir, instanceToken);
  } catch (error) {
    try {
      await service.dispose?.();
    } catch (disposeError) {
      if (disposeError instanceof Error && disposeError.cause === undefined) {
        disposeError.cause = error;
      }
      throw disposeError;
    }
    throw error;
  }
  let running: RunningAcpxConsoleServer;
  try {
    running = await startAcpxConsoleServer({ config, service });
  } catch (error) {
    try {
      await removeOwnedClaim(config.stateDir, instanceToken);
    } catch (cleanupError) {
      if (cleanupError instanceof Error && cleanupError.cause === undefined) {
        cleanupError.cause = error;
      }
      throw cleanupError;
    }
    throw error;
  }
  let control: NetServer | undefined;
  let controlPath: string | undefined;
  let controlSockets = new Set<Socket>();
  let stopStarted: Promise<void> | undefined;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const stop = (): Promise<void> => {
    stopStarted ??= (async () => {
      let failure: unknown;
      let controlClosed = false;
      let serverClosed = false;
      try {
        if (control) {
          await closeNetServer(control, controlSockets);
        }
        controlClosed = true;
        if (controlPath && process.platform !== "win32") {
          await rm(controlPath, { force: true });
        }
      } catch (error) {
        failure = error;
      }
      try {
        await running.close();
        serverClosed = true;
      } catch (error) {
        failure ??= error;
      }
      try {
        if (controlClosed && serverClosed) {
          let runtimeRemoved = false;
          try {
            await removeOwnedRuntime(config.stateDir, instanceToken);
            runtimeRemoved = true;
          } catch (error) {
            failure ??= error;
          }
          if (runtimeRemoved) {
            try {
              await removeOwnedClaim(config.stateDir, instanceToken);
            } catch (error) {
              failure ??= error;
            }
          }
        }
      } finally {
        resolveStopped();
      }
      if (failure !== undefined) {
        throw failure;
      }
    })();
    return stopStarted;
  };
  try {
    const controlResult = await startControlServer(config.stateDir, instanceToken, stop);
    control = controlResult.server;
    controlPath = controlResult.controlPath;
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
    let controlClosed = control === undefined;
    if (control) {
      try {
        await closeNetServer(control, controlSockets);
        controlClosed = true;
      } catch {
        controlClosed = false;
      }
    }
    if (controlPath && process.platform !== "win32") {
      await rm(controlPath, { force: true }).catch(() => undefined);
    }
    let serverClosed = false;
    try {
      await running.close();
      serverClosed = true;
    } catch {
      serverClosed = false;
    }
    if (controlClosed && serverClosed) {
      let runtimeRemoved = false;
      try {
        await removeOwnedRuntime(config.stateDir, instanceToken);
        runtimeRemoved = true;
      } catch {
        runtimeRemoved = false;
      }
      if (runtimeRemoved) {
        await removeOwnedClaim(config.stateDir, instanceToken).catch(() => undefined);
      }
    }
    throw error;
  }
}

async function healthCheck(record: ConsoleRuntimeRecord): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const request = httpRequest(
      {
        host: isWildcardHost(record.host)
          ? record.host.includes(":")
            ? "::1"
            : "127.0.0.1"
          : record.host,
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
  timeoutMs = CONTROL_TIMEOUT_MS,
): Promise<{ ok: boolean; pid?: number; error?: string }> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(record.controlPath);
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
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

async function authenticateRuntime(
  record: ConsoleRuntimeRecord,
  timeoutMs = CONTROL_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const response = await controlRequest(record, "status", timeoutMs);
    return response.ok && response.pid === record.pid;
  } catch {
    return false;
  }
}

export interface ConsoleStatus {
  status: "running" | "unreachable" | "stopped";
  record?: ConsoleRuntimeRecord;
}

export interface ConsoleControlOptions {
  controlTimeoutMs?: number;
}

export async function consoleStatus(
  stateDir: string,
  options: ConsoleControlOptions = {},
): Promise<ConsoleStatus> {
  const [record, claim] = await Promise.all([
    readRuntimeRecord(stateDir),
    readRuntimeClaim(stateDir),
  ]);
  if (claim && isProcessAlive(claim.pid)) {
    if (!record || record.pid !== claim.pid || record.instanceToken !== claim.instanceToken) {
      return { status: "unreachable", ...(record ? { record } : {}) };
    }
  }
  if (!record) {
    return { status: "stopped" };
  }
  if (!isProcessAlive(record.pid)) {
    return { status: "stopped", record };
  }
  if (!(await authenticateRuntime(record, options.controlTimeoutMs))) {
    return { status: "unreachable", record };
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

async function terminateDetachedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  let timeout: NodeJS.Timeout | undefined;
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), 1_000);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

export async function startDetachedConsole(
  config: ResolvedConsoleConfig,
  childArguments: string[],
): Promise<ConsoleRuntimeRecord> {
  await prepareStateDir(config.stateDir);
  const existing = await consoleStatus(config.stateDir);
  if (existing.status !== "stopped") {
    throw new Error(
      `ACPX Console state belongs to a live${existing.status === "unreachable" ? " but unreachable" : ""} process${existing.record ? ` (pid ${existing.record.pid})` : ""}`,
    );
  }
  const paths = lifecyclePaths(config.stateDir);
  await Promise.all([rotateLog(paths.stdout), rotateLog(paths.stderr)]);
  const stdoutHandle = await openFile(paths.stdout, "a", 0o600);
  const stderrHandle = await openFile(paths.stderr, "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, childArguments, {
      detached: true,
      stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
      env: process.env,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    await stdoutHandle.close();
    await stderrHandle.close();
  }
  try {
    const deadline = Date.now() + DETACH_WAIT_MS;
    while (Date.now() < deadline) {
      const [status, claim] = await Promise.all([
        consoleStatus(config.stateDir),
        readRuntimeClaim(config.stateDir),
      ]);
      if (claim && isProcessAlive(claim.pid) && claim.pid !== child.pid) {
        throw new Error(`ACPX Console state was claimed by another process (pid ${claim.pid})`);
      }
      if (status.status === "running" && status.record) {
        if (child.pid !== undefined && status.record.pid !== child.pid) {
          throw new Error(
            `ACPX Console state was claimed by another process (pid ${status.record.pid})`,
          );
        }
        return status.record;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Detached ACPX Console exited before becoming healthy; inspect ${paths.stderr}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Detached ACPX Console did not become healthy; inspect ${paths.stderr}`);
  } catch (error) {
    await terminateDetachedChild(child);
    throw error;
  }
}

export async function stopDetachedConsole(
  stateDir: string,
  options: ConsoleControlOptions = {},
): Promise<ConsoleRuntimeRecord | undefined> {
  const [record, claim] = await Promise.all([
    readRuntimeRecord(stateDir),
    readRuntimeClaim(stateDir),
  ]);
  if (
    claim &&
    isProcessAlive(claim.pid) &&
    (!record || record.pid !== claim.pid || record.instanceToken !== claim.instanceToken)
  ) {
    throw new Error(`ACPX Console is starting or unreachable (pid ${claim.pid})`);
  }
  if (!record) {
    if (claim && isProcessAlive(claim.pid)) {
      throw new Error(`ACPX Console is starting or unreachable (pid ${claim.pid})`);
    }
    return undefined;
  }
  if (!isProcessAlive(record.pid)) {
    return undefined;
  }
  const response = await controlRequest(record, "stop", options.controlTimeoutMs);
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
    void foreground.stop().catch((error: unknown) => {
      console.error(
        `ACPX Console shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
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
