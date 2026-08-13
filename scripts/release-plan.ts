import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ReleasePackage {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

export interface ReleasePlan {
  kind: "stable" | "fork" | "console";
  baseBranch: "main" | "fork-main";
  packageName: "acpx" | "acpx-console";
  version: string;
  npmTag: "latest" | "fork";
  publishRoot: boolean;
  publishConsole: boolean;
}

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const FORK_VERSION = /^\d+\.\d+\.\d+-fork\.\d+$/;

function fail(message: string): never {
  throw new Error(message);
}

export function resolveConsoleAuthMode(input: {
  packageExists: boolean;
  bootstrapRequested: boolean;
}): "oidc" | "bootstrap" {
  if (input.packageExists) {
    if (input.bootstrapRequested) {
      fail("Console bootstrap mode is forbidden after acpx-console exists");
    }
    return "oidc";
  }
  if (!input.bootstrapRequested) {
    fail(
      "The first acpx-console release requires an explicit workflow_dispatch with bootstrap_console enabled",
    );
  }
  return "bootstrap";
}

export function resolveReleasePlan(input: {
  releaseTag: string;
  rootPackage: ReleasePackage;
  consolePackage: ReleasePackage;
}): ReleasePlan {
  const { releaseTag, rootPackage, consolePackage } = input;
  if (rootPackage.name !== "acpx") {
    fail(`Root package manifest name must be exactly acpx; found ${rootPackage.name}`);
  }
  if (consolePackage.name !== "acpx-console") {
    fail(
      `Console package manifest name must be exactly acpx-console; found ${consolePackage.name}`,
    );
  }
  if (releaseTag.startsWith("console-v")) {
    if (!STABLE_VERSION.test(consolePackage.version)) {
      fail(`Console release versions must match X.Y.Z; received ${consolePackage.version}`);
    }
    const expectedTag = `console-v${consolePackage.version}`;
    if (releaseTag !== expectedTag) {
      fail(
        `Release tag ${releaseTag} does not match acpx-console version; expected ${expectedTag}`,
      );
    }
    const acpxVersion = consolePackage.dependencies?.acpx;
    if (!acpxVersion || (!STABLE_VERSION.test(acpxVersion) && !FORK_VERSION.test(acpxVersion))) {
      fail(
        `acpx-console must depend on an exact releasable acpx version; found ${acpxVersion ?? "<missing>"}`,
      );
    }
    return {
      kind: "console",
      baseBranch: "fork-main",
      packageName: "acpx-console",
      version: consolePackage.version,
      npmTag: "latest",
      publishRoot: false,
      publishConsole: true,
    };
  }

  const stable = STABLE_VERSION.test(rootPackage.version);
  const fork = FORK_VERSION.test(rootPackage.version);
  if (!stable && !fork) {
    fail(`Root release versions must match X.Y.Z or X.Y.Z-fork.N; received ${rootPackage.version}`);
  }
  const expectedTag = `v${rootPackage.version}`;
  if (releaseTag !== expectedTag) {
    fail(`Release tag ${releaseTag} does not match acpx version; expected ${expectedTag}`);
  }
  return {
    kind: stable ? "stable" : "fork",
    baseBranch: stable ? "main" : "fork-main",
    packageName: "acpx",
    version: rootPackage.version,
    npmTag: stable ? "latest" : "fork",
    publishRoot: true,
    publishConsole: false,
  };
}

export function readReleasePlan(releaseTag: string, cwd = process.cwd()): ReleasePlan {
  const rootPackage = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8"));
  const consolePackage = JSON.parse(
    readFileSync(resolve(cwd, "packages/console/package.json"), "utf8"),
  );
  return resolveReleasePlan({ releaseTag, rootPackage, consolePackage });
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--console-auth") {
    const packageExists = process.argv[3] === "true";
    const bootstrapRequested = process.argv[4] === "true";
    const outputPath = process.argv[5];
    const mode = resolveConsoleAuthMode({ packageExists, bootstrapRequested });
    if (outputPath) {
      appendFileSync(outputPath, `bootstrap=${mode === "bootstrap"}\n`);
    }
    console.log(`Console release authentication mode: ${mode}.`);
    process.exit(0);
  }
  const releaseTag = process.argv[2] ?? "";
  const outputPath = process.argv[3];
  const plan = readReleasePlan(releaseTag);
  if (outputPath) {
    appendFileSync(
      outputPath,
      [
        `release_kind=${plan.kind}`,
        `base_branch=${plan.baseBranch}`,
        `package_name=${plan.packageName}`,
        `package_version=${plan.version}`,
        `npm_tag=${plan.npmTag}`,
        `publish_root=${plan.publishRoot}`,
        `publish_console=${plan.publishConsole}`,
        "",
      ].join("\n"),
    );
  }
  console.log(
    `Release tag ${releaseTag} selects ${plan.packageName}@${plan.version} with npm dist-tag ${plan.npmTag}.`,
  );
}
