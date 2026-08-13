import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const ciWorkflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
const releaseWorkflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
const consoleManifest = JSON.parse(
  readFileSync(resolve("packages/console/package.json"), "utf8"),
) as {
  scripts?: Record<string, string>;
};

test("CI runs the console package check explicitly", () => {
  assert.match(
    ciWorkflow,
    /- name: Console\n\s+node_version: 22\n\s+command: pnpm --filter acpx-console check/,
  );
});

test("the console check and package lifecycle verify generated third-party notices", () => {
  assert.match(consoleManifest.scripts?.check ?? "", /(?:^|&& )pnpm run notice:check(?: &&|$)/);
  assert.match(consoleManifest.scripts?.prepack ?? "", /^pnpm run notice:check &&/);
});

test("release configures the npm registry before token or trusted publishing", () => {
  const setupNode = releaseWorkflow.match(
    /- uses: actions\/setup-node@v7\n\s+with:\n(?<options>(?:\s{10}.+\n)+)/,
  );
  assert.ok(setupNode?.groups?.options, "actions/setup-node options are missing");
  assert.match(setupNode.groups.options, /registry-url: https:\/\/registry\.npmjs\.org/);
});

test("manual release tags are ancestry-verified before repository code executes", () => {
  const provenance = releaseWorkflow.indexOf(
    "Validate release tag provenance before executing repository code",
  );
  const packageSetup = releaseWorkflow.indexOf("uses: pnpm/action-setup");
  const dependencyInstall = releaseWorkflow.indexOf("run: pnpm install --frozen-lockfile");
  const releasePlan = releaseWorkflow.indexOf("pnpm exec tsx scripts/release-plan.ts");

  assert.ok(provenance >= 0, "release provenance guard is missing");
  assert.ok(provenance < packageSetup, "package setup runs before release provenance is trusted");
  assert.ok(
    provenance < dependencyInstall,
    "dependency scripts run before release provenance is trusted",
  );
  assert.ok(provenance < releasePlan, "repository release code runs before provenance is trusted");
  assert.match(releaseWorkflow, /git merge-base --is-ancestor/);
  assert.match(
    releaseWorkflow,
    /TRUSTED_BASE_BRANCH: \$\{\{ steps\.release_source\.outputs\.base_branch \}\}/,
  );
});

test("release uses the reusable installed-console smoke with the registry acpx dependency", () => {
  assert.match(
    releaseWorkflow,
    /- name: Smoke installed acpx-console with registry acpx[\s\S]*?run: pnpm run smoke:console:package -- --registry-acpx/,
  );
});
