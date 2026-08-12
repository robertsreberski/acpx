import { realpath, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONSOLE_HOST = "127.0.0.1";
export const DEFAULT_CONSOLE_PORT = 4174;

export function defaultConsoleStateDir(homeDir = homedir()): string {
  return join(homeDir, ".acpx", "console");
}

export interface ConsoleConfigFile {
  host?: string;
  port?: number;
  trustNetwork?: boolean;
  workspaceRoots?: string[];
  allowedHosts?: string[];
}

export interface ResolvedConsoleConfig {
  host: string;
  port: number;
  trustNetwork: boolean;
  workspaceRoots: string[];
  allowedHosts: string[];
  stateDir: string;
  staticDir: string;
}

export interface ConsoleConfigOverrides {
  host?: string;
  port?: number;
  trustNetwork?: boolean;
  workspaceRoots?: string[];
  allowedHosts?: string[];
  stateDir?: string;
  staticDir?: string;
  cwd?: string;
  homeDir?: string;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid console port: ${port}`);
  }
}

function normalizeAllowedHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed === "" || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`Invalid allowed host: ${host}`);
  }
  return trimmed.replace(/^\[|\]$/g, "");
}

async function readConfigFile(path: string): Promise<ConsoleConfigFile> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("configuration must be a JSON object");
    }
    const record = value as Record<string, unknown>;
    const stringValue = (key: string): string | undefined => {
      const candidate = record[key];
      if (candidate === undefined) {
        return undefined;
      }
      if (typeof candidate !== "string" || candidate.trim() === "") {
        throw new Error(`${key} must be a non-empty string`);
      }
      return candidate;
    };
    const stringArray = (key: string): string[] | undefined => {
      const candidate = record[key];
      if (candidate === undefined) {
        return undefined;
      }
      if (
        !Array.isArray(candidate) ||
        candidate.length === 0 ||
        candidate.some((item) => typeof item !== "string" || item.trim() === "")
      ) {
        throw new Error(`${key} must be a non-empty array of non-empty strings`);
      }
      return candidate as string[];
    };
    if (record.port !== undefined && typeof record.port !== "number") {
      throw new Error("port must be a number");
    }
    if (record.trustNetwork !== undefined && typeof record.trustNetwork !== "boolean") {
      throw new Error("trustNetwork must be a boolean");
    }
    return {
      host: stringValue("host"),
      port: record.port,
      trustNetwork: record.trustNetwork,
      workspaceRoots: stringArray("workspaceRoots"),
      allowedHosts: stringArray("allowedHosts"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new Error(
      `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export async function resolveConsoleConfig(
  overrides: ConsoleConfigOverrides = {},
): Promise<ResolvedConsoleConfig> {
  const home = overrides.homeDir ?? homedir();
  const cwd = resolve(overrides.cwd ?? process.cwd());
  const configPath = join(home, ".acpx", "console.json");
  const file = await readConfigFile(configPath);
  const host = overrides.host ?? file.host ?? DEFAULT_CONSOLE_HOST;
  const port = overrides.port ?? file.port ?? DEFAULT_CONSOLE_PORT;
  const trustNetwork = overrides.trustNetwork ?? file.trustNetwork ?? false;
  assertPort(port);
  if (!isLoopbackHost(host) && !trustNetwork) {
    throw new Error(
      `Refusing to bind ACPX Console to ${host} without --trust-network; every reachable browser would have full session-control authority`,
    );
  }

  const requestedRoots = overrides.workspaceRoots ?? file.workspaceRoots ?? [cwd];
  if (requestedRoots.length === 0) {
    throw new Error("At least one workspace root is required");
  }
  const workspaceRoots = await Promise.all(
    requestedRoots.map(async (root) => realpath(resolve(cwd, root))),
  );
  const configuredAllowedHosts = overrides.allowedHosts ?? file.allowedHosts;
  if (
    (host === "0.0.0.0" || host === "::") &&
    (!configuredAllowedHosts || configuredAllowedHosts.length === 0)
  ) {
    throw new Error(`A wildcard bind requires at least one explicit --allowed-host value`);
  }
  const defaultHosts = isLoopbackHost(host) ? ["localhost", "127.0.0.1", "::1"] : [host];
  const allowedHosts = [...new Set(configuredAllowedHosts ?? defaultHosts)].map(
    normalizeAllowedHost,
  );

  const stateDir = resolve(overrides.stateDir ?? defaultConsoleStateDir(home));
  const staticDir = resolve(
    overrides.staticDir ?? join(dirname(fileURLToPath(import.meta.url)), "web"),
  );
  return { host, port, trustNetwork, workspaceRoots, allowedHosts, stateDir, staticDir };
}

export async function assertWorkspaceAllowed(cwd: string, roots: string[]): Promise<string> {
  const candidate = await realpath(resolve(cwd));
  const canonicalRoots = await Promise.all(roots.map(async (root) => realpath(resolve(root))));
  const allowed = canonicalRoots.some((root) => {
    const pathFromRoot = relative(root, candidate);
    return (
      pathFromRoot === "" ||
      (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
    );
  });
  if (!allowed) {
    throw new ConsoleInputError(`Workspace is outside the configured roots: ${candidate}`);
  }
  return candidate;
}

export class ConsoleInputError extends Error {
  readonly statusCode = 400;
  readonly code = "INVALID_INPUT";
}
