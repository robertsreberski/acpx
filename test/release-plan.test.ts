import assert from "node:assert/strict";
import test from "node:test";
import { resolveConsoleAuthMode, resolveReleasePlan } from "../scripts/release-plan.js";

const consolePackage = {
  name: "acpx-console",
  version: "0.1.0",
  dependencies: { acpx: "0.13.0-fork.3" },
};

test("stable root releases preserve the latest dist-tag and do not publish console", () => {
  assert.deepEqual(
    resolveReleasePlan({
      releaseTag: "v0.14.0",
      rootPackage: { name: "acpx", version: "0.14.0" },
      consolePackage: { ...consolePackage, dependencies: { acpx: "0.14.0" } },
    }),
    {
      kind: "stable",
      baseBranch: "main",
      packageName: "acpx",
      version: "0.14.0",
      npmTag: "latest",
      publishRoot: true,
      publishConsole: false,
    },
  );
});

test("fork root releases use a non-latest dist-tag and do not republish console", () => {
  assert.deepEqual(
    resolveReleasePlan({
      releaseTag: "v0.13.0-fork.3",
      rootPackage: { name: "acpx", version: "0.13.0-fork.3" },
      consolePackage,
    }),
    {
      kind: "fork",
      baseBranch: "fork-main",
      packageName: "acpx",
      version: "0.13.0-fork.3",
      npmTag: "fork",
      publishRoot: true,
      publishConsole: false,
    },
  );
});

test("console releases are independently tagged and accept an exact published root dependency", () => {
  assert.deepEqual(
    resolveReleasePlan({
      releaseTag: "console-v0.1.0",
      rootPackage: { name: "acpx", version: "0.13.0-fork.3" },
      consolePackage,
    }),
    {
      kind: "console",
      baseBranch: "fork-main",
      packageName: "acpx-console",
      version: "0.1.0",
      npmTag: "latest",
      publishRoot: false,
      publishConsole: true,
    },
  );
});

test("console releases reject dependency ranges and workspace references", () => {
  for (const acpx of ["^0.13.0", "workspace:*"]) {
    assert.throws(
      () =>
        resolveReleasePlan({
          releaseTag: "console-v0.1.0",
          rootPackage: { name: "acpx", version: "0.13.0-fork.3" },
          consolePackage: { ...consolePackage, dependencies: { acpx } },
        }),
      /must depend on an exact releasable acpx version/,
    );
  }
});

test("release planning rejects unexpected manifest names before selecting a route", () => {
  assert.throws(
    () =>
      resolveReleasePlan({
        releaseTag: "console-v0.1.0",
        rootPackage: { name: "acpx-renamed", version: "not-a-release-version" },
        consolePackage,
      }),
    /Root package manifest name must be exactly acpx; found acpx-renamed/,
  );
  assert.throws(
    () =>
      resolveReleasePlan({
        releaseTag: "v0.13.0-fork.3",
        rootPackage: { name: "acpx", version: "0.13.0-fork.3" },
        consolePackage: { ...consolePackage, name: "acpx-console-renamed", version: "invalid" },
      }),
    /Console package manifest name must be exactly acpx-console; found acpx-console-renamed/,
  );
});

test("release tags must exactly match the selected package version", () => {
  assert.throws(
    () =>
      resolveReleasePlan({
        releaseTag: "v0.13.0",
        rootPackage: { name: "acpx", version: "0.13.0-fork.3" },
        consolePackage,
      }),
    /expected v0\.13\.0-fork\.3/,
  );
  assert.throws(
    () =>
      resolveReleasePlan({
        releaseTag: "console-v0.2.0",
        rootPackage: { name: "acpx", version: "0.13.0-fork.3" },
        consolePackage,
      }),
    /expected console-v0\.1\.0/,
  );
});

test("console authentication permits a token only for an explicit first-release bootstrap", () => {
  assert.equal(
    resolveConsoleAuthMode({ packageExists: false, bootstrapRequested: true }),
    "bootstrap",
  );
  assert.equal(resolveConsoleAuthMode({ packageExists: true, bootstrapRequested: false }), "oidc");
  assert.throws(
    () => resolveConsoleAuthMode({ packageExists: false, bootstrapRequested: false }),
    /requires an explicit workflow_dispatch/,
  );
  assert.throws(
    () => resolveConsoleAuthMode({ packageExists: true, bootstrapRequested: true }),
    /forbidden after acpx-console exists/,
  );
});
