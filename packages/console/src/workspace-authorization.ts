import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ConsoleInputError } from "./config.js";

/**
 * Operator authorization for a workspace outside the configured roots.
 *
 * `--workspace-root` stays the standing allowlist: anything under it needs no
 * further proof. A directory outside it is refused until the operator
 * authorizes that exact directory once, and the grant is recorded in private
 * console state so the refusal does not repeat.
 *
 * Grants are keyed by the *canonical* path. Authorizing a symlink therefore
 * grants its target at the moment of authorization, and re-pointing the symlink
 * later does not inherit the grant.
 */

/**
 * Raised when a directory is real and readable but carries no grant. Its own
 * status and code let the console offer to authorize it, instead of presenting
 * a dead validation error.
 */
export class WorkspaceAuthorizationRequiredError extends ConsoleInputError {
  override readonly statusCode = 403;
  override readonly code = "WORKSPACE_NOT_AUTHORIZED";
  readonly canonicalPath: string;

  constructor(canonicalPath: string) {
    super(`Workspace has not been authorized: ${canonicalPath}`);
    this.name = "WorkspaceAuthorizationRequiredError";
    this.canonicalPath = canonicalPath;
  }
}

export const isInsideRoots = (canonicalPath: string, roots: readonly string[]): boolean =>
  roots.some((root) => {
    const pathFromRoot = relative(root, canonicalPath);
    return (
      pathFromRoot === "" ||
      (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
    );
  });

const grantPath = (stateDir: string, canonicalPath: string): string =>
  join(
    resolve(stateDir),
    "operator-workspace-authorizations",
    createHash("sha256").update(canonicalPath).digest("hex"),
  );

export const readWorkspaceGrant = async (
  stateDir: string,
  canonicalPath: string,
): Promise<boolean> => {
  try {
    const value = await readFile(grantPath(stateDir, canonicalPath), "utf8");
    // The stored path is compared verbatim so a hash collision cannot widen a grant.
    return value.trimEnd() === canonicalPath;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
};

export const writeWorkspaceGrant = async (
  stateDir: string,
  canonicalPath: string,
): Promise<void> => {
  const marker = grantPath(stateDir, canonicalPath);
  await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
  const temporary = `${marker}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${canonicalPath}\n`, { mode: 0o600 });
    await rename(temporary, marker);
  } finally {
    await rm(temporary, { force: true });
  }
};

/** Canonicalize a directory the operator named, refusing anything that is not one. */
export const canonicalDirectory = async (cwd: string): Promise<string> => {
  const requested = resolve(cwd);
  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") {
      throw new ConsoleInputError(`Workspace is not accessible: ${requested}`);
    }
    throw error;
  }
  if (!(await stat(canonical)).isDirectory()) {
    throw new ConsoleInputError(`Workspace is not a directory: ${requested}`);
  }
  return canonical;
};

/**
 * Resolve a workspace for a new session: inside a configured root, or carrying
 * an operator grant for that exact canonical directory.
 */
export const assertWorkspaceUsable = async (
  cwd: string,
  roots: readonly string[],
  stateDir: string,
): Promise<string> => {
  const canonical = await canonicalDirectory(cwd);
  if (isInsideRoots(canonical, roots)) {
    return canonical;
  }
  if (await readWorkspaceGrant(stateDir, canonical)) {
    return canonical;
  }
  throw new WorkspaceAuthorizationRequiredError(canonical);
};

export interface WorkspaceSuggestion {
  readonly path: string;
  readonly label: string;
  readonly authorized: boolean;
}

const MAX_SUGGESTIONS = 40;

/**
 * Directory completions for a partially typed path.
 *
 * Directories only, and never their contents: this answers "what could I pick",
 * not "what is in there". Hidden directories appear only once the operator has
 * typed the leading dot, so ordinary browsing does not enumerate dotfiles.
 */
export const suggestWorkspaces = async (
  prefix: string,
  roots: readonly string[],
  stateDir: string,
  home: string = homedir(),
): Promise<readonly WorkspaceSuggestion[]> => {
  // The leaf is taken from the raw text rather than a resolved path: resolve()
  // collapses a trailing "." or "..", which would make a half-typed hidden
  // directory indistinguishable from its parent.
  const raw = prefix.trim() === "" ? `${resolve(roots[0] ?? ".")}${sep}` : prefix;
  const lastSeparator = raw.lastIndexOf(sep);
  const parent = resolve(
    lastSeparator <= 0 ? raw.slice(0, lastSeparator + 1) || sep : raw.slice(0, lastSeparator),
  );
  const leaf = raw.slice(lastSeparator + 1).toLocaleLowerCase();
  /*
   * Completion is a convenience for reaching a project, not a filesystem
   * browser. Restricting it to the configured roots and the operator's home
   * keeps `/etc` and friends from being enumerated before any authorization has
   * happened. Anywhere else is still reachable — it just has to be typed in
   * full and authorized, which is the same explicit step it always required.
   */
  if (!isInsideRoots(parent, [...roots, home])) {
    return [];
  }
  let entries: Dirent[];
  try {
    entries = await readdir(parent, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const matches = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => (leaf.startsWith(".") ? true : !name.startsWith(".")))
    .filter((name) => name.toLocaleLowerCase().startsWith(leaf))
    .toSorted((left, right) => left.localeCompare(right))
    .slice(0, MAX_SUGGESTIONS);
  return await Promise.all(
    matches.map(async (name) => {
      const path = join(parent, name);
      let authorized = isInsideRoots(path, roots);
      if (!authorized) {
        authorized = await readWorkspaceGrant(stateDir, path).catch(() => false);
      }
      return { path, label: name, authorized };
    }),
  );
};
