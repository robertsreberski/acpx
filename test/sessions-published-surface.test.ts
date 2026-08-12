import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DIST_SESSIONS_URL = new URL("../../dist/sessions.js", import.meta.url);

const PUBLISHED_VALUES = [
  "AcpxAgentNotRegisteredError",
  "AcpxIdempotencyConflictError",
  "AcpxIdempotencyCorruptError",
  "AcpxSessionAdoptionError",
  "AcpxTurnNotActiveError",
  "SessionTimelineCursorError",
  "createAcpxSessionService",
] as const;

const PUBLISHED_TYPES = [
  "AcpxCreateSessionInput",
  "AcpxMutationReceipt",
  "AcpxPendingRequest",
  "AcpxRegisteredAgent",
  "AcpxSessionDetail",
  "AcpxSessionService",
  "AcpxSessionSummary",
  "AcpxTranscriptPage",
  "SessionTimelineEvent",
] as const;

test("dist/sessions.js exports the stable service values", async () => {
  const sessions = (await import(DIST_SESSIONS_URL.href)) as Record<string, unknown>;
  for (const name of PUBLISHED_VALUES) {
    assert.equal(name in sessions, true, `dist/sessions.js does not export ${name}`);
  }
  assert.equal(typeof sessions.createAcpxSessionService, "function");
});

test("the acpx/sessions subpath types are importable by a package consumer", () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "acpx-sessions-dts-check-"));
  const fixturePath = path.join(fixtureDir, "fixture.ts");
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

  try {
    mkdirSync(path.join(fixtureDir, "node_modules"), { recursive: true });
    symlinkSync(packageRoot, path.join(fixtureDir, "node_modules", "acpx"), "dir");
    writeFileSync(
      fixturePath,
      [
        'import { createAcpxSessionService } from "acpx/sessions";',
        `import type { ${PUBLISHED_TYPES.join(", ")} } from "acpx/sessions";`,
        "const service = createAcpxSessionService();",
        "service.dispose();",
        ...PUBLISHED_TYPES.map((name, index) =>
          name === "AcpxMutationReceipt"
            ? `declare const probe${index}: ${name}<unknown>;`
            : `declare const probe${index}: ${name};`,
        ),
        `export type Probe = [${PUBLISHED_TYPES.map((_, index) => `typeof probe${index}`).join(", ")}];`,
        "",
      ].join("\n"),
      "utf8",
    );

    const tsc = fileURLToPath(new URL("../../node_modules/.bin/tsc", import.meta.url));
    const compiled = spawnSync(
      tsc,
      [
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "es2023",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        fixturePath,
      ],
      { cwd: fixtureDir, encoding: "utf8" },
    );
    assert.equal(
      compiled.status,
      0,
      `consumer import of acpx/sessions failed:\n${compiled.stdout}${compiled.stderr}`,
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
