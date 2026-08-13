import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertWorkspaceUsable,
  suggestWorkspaces,
  WorkspaceAuthorizationRequiredError,
  writeWorkspaceGrant,
} from "../src/workspace-authorization.js";

const fixture = async () => {
  // Canonical, as the console canonicalizes configured roots at startup: on
  // macOS the temp dir is reached through a /var -> /private/var symlink.
  const base = await realpathOf(await mkdtemp(join(tmpdir(), "acpx-console-authz-")));
  const roots = join(base, "roots");
  const outside = join(base, "outside");
  const stateDir = join(base, "state");
  await Promise.all([
    mkdir(join(roots, "project"), { recursive: true }),
    mkdir(join(outside, "elsewhere"), { recursive: true }),
    mkdir(join(outside, ".hidden"), { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);
  await writeFile(join(outside, "a-file.txt"), "not a directory\n", "utf8");
  return { base, roots, outside, stateDir };
};

test("a workspace inside the configured roots needs no grant", async () => {
  const { roots, stateDir } = await fixture();
  const resolved = await assertWorkspaceUsable(join(roots, "project"), [roots], stateDir);
  assert.match(resolved, /project$/u);
});

test("a workspace outside the roots is refused until it is authorized", async () => {
  const { roots, outside, stateDir } = await fixture();
  const target = join(outside, "elsewhere");
  await assert.rejects(
    async () => await assertWorkspaceUsable(target, [roots], stateDir),
    WorkspaceAuthorizationRequiredError,
  );
  await writeWorkspaceGrant(stateDir, await realpathOf(target));
  assert.equal(await assertWorkspaceUsable(target, [roots], stateDir), await realpathOf(target));
});

test("a grant covers the authorized directory only, not its neighbours or parent", async () => {
  const { roots, outside, stateDir } = await fixture();
  await writeWorkspaceGrant(stateDir, await realpathOf(join(outside, "elsewhere")));
  await assert.rejects(
    async () => await assertWorkspaceUsable(outside, [roots], stateDir),
    WorkspaceAuthorizationRequiredError,
  );
  await assert.rejects(
    async () => await assertWorkspaceUsable(join(outside, ".hidden"), [roots], stateDir),
    WorkspaceAuthorizationRequiredError,
  );
});

test("suggestions offer directories only, and hide dotfiles until they are asked for", async () => {
  const { base, roots, outside, stateDir } = await fixture();
  const plain = await suggestWorkspaces(`${outside}/`, [roots], stateDir, base);
  assert.deepEqual(
    plain.map((entry) => entry.label),
    ["elsewhere"],
  );
  const hidden = await suggestWorkspaces(`${outside}/.`, [roots], stateDir, base);
  assert.deepEqual(
    hidden.map((entry) => entry.label),
    [".hidden"],
  );
});

test("suggestions report whether picking one would need authorizing", async () => {
  const { base, roots, outside, stateDir } = await fixture();
  const inside = await suggestWorkspaces(`${roots}/`, [roots], stateDir, base);
  assert.deepEqual(
    inside.map((entry) => entry.authorized),
    [true],
  );
  const before = await suggestWorkspaces(`${outside}/`, [roots], stateDir, base);
  assert.deepEqual(
    before.map((entry) => entry.authorized),
    [false],
  );
  await writeWorkspaceGrant(stateDir, await realpathOf(join(outside, "elsewhere")));
  const after = await suggestWorkspaces(`${outside}/`, [roots], stateDir, base);
  assert.deepEqual(
    after.map((entry) => entry.authorized),
    [true],
  );
});

const realpathOf = async (path: string): Promise<string> =>
  await (await import("node:fs/promises")).realpath(path);

test("completion does not enumerate outside the roots and the operator's home", () => {
  return (async () => {
    const { base, roots, stateDir } = await fixture();
    // A path the operator could still type in full and authorize, but which
    // completion will not browse: no pre-authorization directory listing.
    assert.deepEqual(await suggestWorkspaces("/etc/", [roots], stateDir, base), []);
    assert.deepEqual(await suggestWorkspaces("/", [roots], stateDir, base), []);
  })();
});
