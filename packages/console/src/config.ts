import { realpath, readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
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

export function isWildcardHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "0.0.0.0") {
    return true;
  }
  if (normalized.includes(":")) {
    try {
      return new URL(`http://[${normalized}]`).hostname === "[::]";
    } catch {
      return false;
    }
  }
  return false;
}

export function consoleDisplayHost(
  config: Pick<ResolvedConsoleConfig, "host" | "allowedHosts">,
): string {
  if (!isWildcardHost(config.host)) {
    return config.host;
  }
  const displayHost = config.allowedHosts.find((host) => !isWildcardHost(host));
  if (!displayHost) {
    throw new Error("A wildcard bind requires an explicit non-wildcard allowed host");
  }
  return displayHost;
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid console port: ${port}`);
  }
}

function normalizeAllowedHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  const bare = trimmed.replace(/^\[|\]$/g, "");
  if (
    trimmed === "" ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    /^\[[^\]]+\]:\d+$/.test(trimmed) ||
    /^[^:[\]]+:\d+$/.test(trimmed) ||
    (bare.includes(":") && isIP(bare) !== 6) ||
    (!bare.includes(":") &&
      isIP(bare) === 0 &&
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(
        bare,
      ))
  ) {
    throw new Error(`Invalid allowed host: ${host}`);
  }
  return bare;
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
  if (isWildcardHost(host) && (!configuredAllowedHosts || configuredAllowedHosts.length === 0)) {
    throw new Error(`A wildcard bind requires at least one explicit --allowed-host value`);
  }
  const defaultHosts = isLoopbackHost(host) ? ["localhost", "127.0.0.1", "::1"] : [host];
  const allowedHosts = [...new Set(configuredAllowedHosts ?? defaultHosts)].map(
    normalizeAllowedHost,
  );
  if (isWildcardHost(host) && !allowedHosts.some((allowedHost) => !isWildcardHost(allowedHost))) {
    throw new Error("A wildcard bind requires an explicit non-wildcard allowed host");
  }

  const stateDir = resolve(overrides.stateDir ?? defaultConsoleStateDir(home));
  const staticDir = resolve(
    overrides.staticDir ?? join(dirname(fileURLToPath(import.meta.url)), "web"),
  );
  return { host, port, trustNetwork, workspaceRoots, allowedHosts, stateDir, staticDir };
}

export async function assertWorkspaceAllowed(cwd: string, roots: string[]): Promise<string> {
  let candidate: string;
  try {
    candidate = await realpath(resolve(cwd));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") {
      throw new ConsoleInputError(`Workspace is not accessible: ${resolve(cwd)}`);
    }
    throw error;
  }
  await assertCanonicalWorkspaceAllowed(candidate, candidate, roots);
  return candidate;
}

async function assertCanonicalWorkspaceAllowed(
  canonicalCandidate: string,
  reportedCandidate: string,
  roots: string[],
): Promise<void> {
  const canonicalRoots = await Promise.all(
    roots.map(async (root) => await realpath(resolve(root))),
  );
  const allowed = canonicalRoots.some((root) => {
    const pathFromRoot = relative(root, canonicalCandidate);
    return (
      pathFromRoot === "" ||
      (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
    );
  });
  if (!allowed) {
    throw new ConsoleInputError(`Workspace is outside the configured roots: ${reportedCandidate}`);
  }
}

async function nearestExistingDirectory(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      const canonical = await realpath(current);
      if (!(await stat(canonical)).isDirectory()) {
        throw new ConsoleInputError(`Workspace is not accessible: ${candidate}`);
      }
      return canonical;
    } catch (error) {
      if (error instanceof ConsoleInputError) {
        throw error;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new ConsoleInputError(`Workspace is not accessible: ${candidate}`);
      }
      current = parent;
    }
  }
}

/**
 * Authorize the cwd stored on an existing session record.
 *
 * New sessions still use {@link assertWorkspaceAllowed} and therefore require
 * an existing directory. A retained session must remain controllable after its
 * workspace leaf is deleted or renamed, so a missing suffix is accepted only
 * when its nearest existing directory resolves inside a configured root. This
 * also resolves any surviving symlink prefix before the boundary check.
 */
export async function assertRetainedWorkspaceAllowed(
  cwd: string,
  roots: string[],
): Promise<string> {
  const candidate = resolve(cwd);
  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw error;
    }
    canonicalCandidate = await nearestExistingDirectory(candidate);
  }

  await assertCanonicalWorkspaceAllowed(canonicalCandidate, candidate, roots);
  return candidate;
}

export class ConsoleInputError extends Error {
  readonly statusCode = 400;
  readonly code = "INVALID_INPUT";
}
