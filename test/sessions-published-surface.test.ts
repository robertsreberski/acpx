import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
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
  "AcpxModeState",
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

test("the published sessions bundle spawns its sibling CLI for queue admission", async () => {
  const homeDir = await fs.mkdtemp(path.join(tmpdir(), "acpx-sessions-bundle-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  const cwd = path.join(homeDir, "workspace");
  const mockAgentPath = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
  await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(
    path.join(homeDir, ".acpx", "config.json"),
    `${JSON.stringify({
      agents: {
        bundled: {
          command: process.execPath,
          args: [mockAgentPath, "--supports-resume-session"],
        },
      },
    })}\n`,
    "utf8",
  );

  try {
    const sessions = (await import(DIST_SESSIONS_URL.href)) as {
      createAcpxSessionService(options?: { cwd?: string }): {
        createSession(input: {
          agentId: string;
          cwd: string;
          idempotencyKey: string;
        }): Promise<{ result: { acpxRecordId: string } }>;
        enqueuePrompt(input: {
          acpxRecordId: string;
          prompt: string;
          idempotencyKey: string;
        }): Promise<{ result: { admission: string } }>;
        closeSession(input: { acpxRecordId: string; idempotencyKey: string }): Promise<unknown>;
        dispose(): void;
      };
    };
    const service = sessions.createAcpxSessionService({ cwd });
    const created = await service.createSession({
      agentId: "bundled",
      cwd,
      idempotencyKey: "published-create",
    });
    const admitted = await service.enqueuePrompt({
      acpxRecordId: created.result.acpxRecordId,
      prompt: "echo published bundle",
      idempotencyKey: "published-enqueue",
    });
    assert.equal(admitted.result.admission, "queued");
    await service.closeSession({
      acpxRecordId: created.result.acpxRecordId,
      idempotencyKey: "published-close",
    });
    service.dispose();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  }
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
