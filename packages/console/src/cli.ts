#!/usr/bin/env node
import { resolve } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };
import { CLI_USAGE, parseConsoleCommand } from "./cli-options.js";
import { defaultConsoleStateDir, resolveConsoleConfig } from "./config.js";
import {
  attachShutdownSignals,
  consoleStatus,
  openConsole,
  startDetachedConsole,
  startForegroundConsole,
  stopDetachedConsole,
} from "./lifecycle.js";
import { loadAcpxSessionService } from "./service-loader.js";

function childStartArguments(
  command: Extract<ReturnType<typeof parseConsoleCommand>, { command: "start" }>,
): string[] {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error("Cannot locate the acpx-console entrypoint");
  }
  const args = [entrypoint, "start", "--internal-child"];
  if (command.host) {
    args.push("--host", command.host);
  }
  if (command.port !== undefined) {
    args.push("--port", String(command.port));
  }
  if (command.trustNetwork) {
    args.push("--trust-network");
  }
  if (command.stateDir) {
    args.push("--state-dir", command.stateDir);
  }
  if (command.staticDir) {
    args.push("--static-dir", command.staticDir);
  }
  for (const root of command.workspaceRoots) {
    args.push("--workspace-root", root);
  }
  for (const host of command.allowedHosts) {
    args.push("--allowed-host", host);
  }
  return args;
}

async function main(): Promise<void> {
  const command = parseConsoleCommand(process.argv.slice(2));
  if (command.command === "help") {
    console.log(CLI_USAGE);
    return;
  }
  if (command.command === "version") {
    console.log(packageMetadata.version);
    return;
  }
  const stateDir = resolve(command.stateDir ?? defaultConsoleStateDir());
  if (command.command === "status") {
    const status = await consoleStatus(stateDir);
    if (command.json) {
      console.log(JSON.stringify(status));
    } else if (status.record) {
      console.log(`${status.status}: ${status.record.origin} (pid ${status.record.pid})`);
    } else {
      console.log(status.status);
    }
    if (status.status !== "running") {
      process.exitCode = 1;
    }
    return;
  }
  if (command.command === "stop") {
    const stopped = await stopDetachedConsole(stateDir);
    console.log(
      stopped ? `Stopped ACPX Console pid ${stopped.pid}` : "ACPX Console is not running",
    );
    return;
  }
  const config = await resolveConsoleConfig({
    stateDir: command.stateDir,
    ...(command.command === "start"
      ? {
          host: command.host,
          port: command.port,
          trustNetwork: command.trustNetwork,
          workspaceRoots: command.workspaceRoots.length > 0 ? command.workspaceRoots : undefined,
          allowedHosts: command.allowedHosts.length > 0 ? command.allowedHosts : undefined,
          staticDir: command.staticDir,
        }
      : {}),
  });
  if (command.detach) {
    const record = await startDetachedConsole(config, childStartArguments(command));
    console.log(`ACPX Console started at ${record.origin} (pid ${record.pid})`);
    if (command.open) {
      await openConsole(record.origin);
    }
    return;
  }
  const service = await loadAcpxSessionService();
  const foreground = await startForegroundConsole(config, service);
  const detachSignals = attachShutdownSignals(foreground);
  if (command.open) {
    await openConsole(foreground.record.origin);
  }
  await foreground.stopped;
  detachSignals();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
