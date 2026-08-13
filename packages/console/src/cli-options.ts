export type ConsoleCommand =
  | { command: "help" }
  | { command: "version" }
  | { command: "status"; json: boolean; stateDir?: string }
  | { command: "stop"; stateDir?: string }
  | {
      command: "start";
      detach: boolean;
      internalChild: boolean;
      open: boolean;
      host?: string;
      port?: number;
      trustNetwork?: boolean;
      workspaceRoots: string[];
      allowedHosts: string[];
      stateDir?: string;
      staticDir?: string;
    };

export const CLI_USAGE = `Usage: acpx-console <command> [options]

Commands:
  start                    Start ACPX Console in the foreground
  start --detach           Start ACPX Console in the background
  status [--json]          Report the detached console's health
  stop                     Stop the console through its private control socket

Start options:
  --host <host>            Bind host (default: 127.0.0.1)
  --port <port>            Bind port (default: 4174)
  --open                   Open the console in the default browser
  --trust-network          Permit a non-loopback bind (no application login)
  --workspace-root <path>  Allow a browser-selectable workspace (repeatable)
  --allowed-host <host>    Allow an HTTP Host value (repeatable)

General:
  -h, --help               Show help
  -v, --version            Show version`;

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseConsoleCommand(argv: string[]): ConsoleCommand {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { command: "help" };
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    return { command: "version" };
  }
  const verb = argv[0];
  if (verb !== "start" && verb !== "status" && verb !== "stop") {
    throw new Error(`Unknown command: ${verb}`);
  }
  if (verb === "status") {
    let json = false;
    let stateDir: string | undefined;
    for (let index = 1; index < argv.length; index++) {
      const token = argv[index];
      if (token === "--json") {
        json = true;
      } else if (token === "--state-dir") {
        stateDir = takeValue(argv, index++, token);
      } else {
        throw new Error(`Unknown status option: ${token}`);
      }
    }
    return { command: "status", json, stateDir };
  }
  if (verb === "stop") {
    let stateDir: string | undefined;
    for (let index = 1; index < argv.length; index++) {
      const token = argv[index];
      if (token === "--state-dir") {
        stateDir = takeValue(argv, index++, token);
      } else {
        throw new Error(`Unknown stop option: ${token}`);
      }
    }
    return { command: "stop", stateDir };
  }
  const result: Extract<ConsoleCommand, { command: "start" }> = {
    command: "start",
    detach: false,
    internalChild: false,
    open: false,
    workspaceRoots: [],
    allowedHosts: [],
  };
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--detach") {
      result.detach = true;
    } else if (token === "--internal-child") {
      result.internalChild = true;
    } else if (token === "--open") {
      result.open = true;
    } else if (token === "--trust-network") {
      result.trustNetwork = true;
    } else if (token === "--host") {
      result.host = takeValue(argv, index++, token);
    } else if (token === "--port") {
      const raw = takeValue(argv, index++, token);
      result.port = Number(raw);
      if (!Number.isInteger(result.port)) {
        throw new Error(`Invalid port: ${raw}`);
      }
    } else if (token === "--workspace-root") {
      result.workspaceRoots.push(takeValue(argv, index++, token));
    } else if (token === "--allowed-host") {
      result.allowedHosts.push(takeValue(argv, index++, token));
    } else if (token === "--state-dir") {
      result.stateDir = takeValue(argv, index++, token);
    } else if (token === "--static-dir") {
      result.staticDir = takeValue(argv, index++, token);
    } else {
      throw new Error(`Unknown start option: ${token}`);
    }
  }
  if (result.detach && result.internalChild) {
    throw new Error("Internal child cannot detach again");
  }
  return result;
}
