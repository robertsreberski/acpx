import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertRetainedWorkspaceAllowed,
  assertWorkspaceAllowed,
  consoleDisplayHost,
  resolveConsoleConfig,
} from "../src/config.js";

test("console defaults to a loopback bind and the current workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-config-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  await Promise.all([mkdir(join(home, ".acpx"), { recursive: true }), mkdir(cwd)]);
  const config = await resolveConsoleConfig({ homeDir: home, cwd });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 4174);
  assert.equal(config.trustNetwork, false);
  assert.deepEqual(config.workspaceRoots, [await realpath(cwd)]);
  assert.deepEqual(config.allowedHosts, ["localhost", "127.0.0.1", "::1"]);
});

test("non-loopback binding requires an explicit network trust decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-config-"));
  await assert.rejects(
    resolveConsoleConfig({ homeDir: root, cwd: root, host: "0.0.0.0" }),
    /--trust-network/,
  );
  const config = await resolveConsoleConfig({
    homeDir: root,
    cwd: root,
    host: "0.0.0.0",
    trustNetwork: true,
    allowedHosts: ["console.example.test"],
  });
  assert.equal(config.trustNetwork, true);
  assert.deepEqual(config.allowedHosts, ["console.example.test"]);
  assert.equal(consoleDisplayHost(config), "console.example.test");
  await assert.rejects(
    resolveConsoleConfig({ homeDir: root, cwd: root, host: "0.0.0.0", trustNetwork: true }),
    /explicit --allowed-host/,
  );
  await assert.rejects(
    resolveConsoleConfig({
      homeDir: root,
      cwd: root,
      host: "0.0.0.0",
      trustNetwork: true,
      allowedHosts: ["0.0.0.0"],
    }),
    /non-wildcard allowed host/,
  );
  for (const wildcard of [
    "::0",
    "0::",
    "0:0:0:0:0:0::",
    "::0:0",
    "0000::0000",
    "0:0:0:0:0:0:0:0",
  ]) {
    await assert.rejects(
      resolveConsoleConfig({
        homeDir: root,
        cwd: root,
        host: wildcard,
        trustNetwork: true,
        allowedHosts: [wildcard],
      }),
      /non-wildcard allowed host/,
    );
  }
  for (const allowedHost of [
    "console.example.test:4174",
    "[::1]:4174",
    "console.example:notaport",
    "foo:bar",
  ]) {
    await assert.rejects(
      resolveConsoleConfig({
        homeDir: root,
        cwd: root,
        host: "0.0.0.0",
        trustNetwork: true,
        allowedHosts: [allowedHost],
      }),
      /Invalid allowed host/,
    );
  }
});

test("workspace validation resolves symlinks before enforcing roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-root-"));
  const canonicalRoot = await realpath(root);
  const inside = join(root, "inside");
  const outside = await mkdtemp(join(tmpdir(), "acpx-console-outside-"));
  await mkdir(inside);
  await writeFile(join(inside, "file"), "ok");
  assert.equal(await assertWorkspaceAllowed(inside, [canonicalRoot]), await realpath(inside));
  await assert.rejects(
    assertWorkspaceAllowed(outside, [canonicalRoot]),
    /outside the configured roots/,
  );
});

test("retained workspace validation allows only missing suffixes under canonical roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-retained-root-"));
  const canonicalRoot = await realpath(root);
  const state = join(root, "state");
  const project = join(root, "project");
  const replacedParent = join(root, "replaced-parent");
  const replacedProject = join(replacedParent, "project");
  const outside = await mkdtemp(join(tmpdir(), "acpx-console-retained-outside-"));
  const escape = join(root, "escape");
  const unseenEscape = join(root, "unseen-escape");
  await Promise.all([
    mkdir(project),
    mkdir(replacedProject, { recursive: true }),
    symlink(outside, escape, "dir"),
    symlink(outside, unseenEscape, "dir"),
  ]);

  assert.equal(
    await assertRetainedWorkspaceAllowed("project", project, [canonicalRoot], state),
    project,
  );
  assert.equal(
    await assertRetainedWorkspaceAllowed("replaced", replacedProject, [canonicalRoot], state),
    replacedProject,
  );
  await assert.rejects(
    assertRetainedWorkspaceAllowed("escape", join(escape, "missing"), [canonicalRoot], state),
    /outside the configured roots/,
  );

  await Promise.all([
    rm(project, { recursive: true }),
    rm(replacedParent, { recursive: true }),
    rm(escape),
    rm(unseenEscape),
  ]);
  await symlink(outside, replacedParent, "dir");
  assert.equal(
    await assertRetainedWorkspaceAllowed("project", project, [canonicalRoot], state),
    project,
  );
  await assert.rejects(
    assertRetainedWorkspaceAllowed("different-record", project, [canonicalRoot], state),
    /Workspace is not accessible/,
  );
  await assert.rejects(
    assertRetainedWorkspaceAllowed("replaced", replacedProject, [canonicalRoot], state),
    /outside the configured roots/,
  );
  await assert.rejects(
    assertRetainedWorkspaceAllowed("escape", join(escape, "missing"), [canonicalRoot], state),
    /outside the configured roots/,
  );
  await assert.rejects(
    assertRetainedWorkspaceAllowed("unseen", unseenEscape, [canonicalRoot], state),
    /Workspace is not accessible/,
  );

  await assert.rejects(
    assertRetainedWorkspaceAllowed("outside", join(outside, "missing"), [canonicalRoot], state),
    /outside the configured roots/,
  );
  await assert.rejects(
    assertWorkspaceAllowed(project, [canonicalRoot]),
    /Workspace is not accessible/,
  );
});

test("invalid persisted configuration fails with the config path instead of coercing values", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-invalid-config-"));
  const configDir = join(root, ".acpx");
  await mkdir(configDir);
  await writeFile(join(configDir, "console.json"), JSON.stringify({ host: 42 }));
  await assert.rejects(resolveConsoleConfig({ homeDir: root, cwd: root }), /console\.json: host/);
});
