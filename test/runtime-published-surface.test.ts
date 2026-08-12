import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// These assertions run against the BUILT artifact, not src. A symbol can exist
// in src, typecheck fine, and still be unreachable for anyone installing the
// package — which is exactly how matchPermissionPolicy shipped "exported" while
// dist/runtime.js never listed it.
const DIST_RUNTIME_URL = new URL("../../dist/runtime.js", import.meta.url);

const PUBLISHED_VALUES = [
  "matchPermissionPolicy",
  "PERMISSION_ESCALATION_ACTIONS",
  "PERMISSION_MODES",
  "PERMISSION_POLICY_ACTIONS",
  "PERMISSION_POLICY_RULE_KEYS",
] as const;

const PUBLISHED_TYPES = [
  "AcpPermissionDecision",
  "AcpPermissionRequest",
  "AcpPermissionRequestContext",
  "PermissionEscalationAction",
  "PermissionEscalationEvent",
  "PermissionMode",
  "PermissionPolicy",
  "PermissionPolicyAction",
  "PermissionPolicyMatch",
  "PermissionPolicyRuleKey",
  "ReadonlyPermissionPolicy",
] as const;

test("dist/runtime.js exports the permission policy values consumers need", async () => {
  const runtime = (await import(DIST_RUNTIME_URL.href)) as Record<string, unknown>;

  for (const name of PUBLISHED_VALUES) {
    assert.equal(name in runtime, true, `dist/runtime.js does not export ${name}`);
  }

  assert.equal(typeof runtime.matchPermissionPolicy, "function");
  assert.deepEqual(runtime.PERMISSION_POLICY_ACTIONS, ["approve", "deny", "escalate", "defer"]);
  assert.deepEqual(runtime.PERMISSION_ESCALATION_ACTIONS, ["escalate", "defer"]);
  assert.deepEqual(runtime.PERMISSION_POLICY_RULE_KEYS, [
    "autoApprove",
    "autoDeny",
    "escalate",
    "defer",
  ]);
});

test("dist/runtime.js matchPermissionPolicy classifies a deferred request", async () => {
  const runtime = (await import(DIST_RUNTIME_URL.href)) as {
    matchPermissionPolicy: (
      params: unknown,
      policy: unknown,
    ) => { action: string; matchedRule?: string } | undefined;
  };

  const request = {
    sessionId: "published-session",
    toolCall: { toolCallId: "published-tool", kind: "execute", title: "Bash: pnpm test" },
    options: [
      { optionId: "allow", kind: "allow_once" },
      { optionId: "reject", kind: "reject_once" },
    ],
  };

  assert.deepEqual(runtime.matchPermissionPolicy(request, { defer: ["execute"] }), {
    action: "defer",
    matchedRule: "execute",
  });
  assert.equal(runtime.matchPermissionPolicy(request, {}), undefined);
});

test("dist/runtime.d.ts types are importable by a consumer", () => {
  // Searching the whole .d.ts proves nothing: rolldown-dts emits an internal
  // `type X = {…}` for anything an exported signature references, so a name is
  // present in the file even when its re-export was dropped. Only compiling an
  // import against the emitted declarations shows what a consumer can name.
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "acpx-dts-check-"));
  const fixturePath = path.join(fixtureDir, "fixture.ts");
  const specifier = path
    .relative(fixtureDir, fileURLToPath(DIST_RUNTIME_URL))
    .split(path.sep)
    .join("/");

  try {
    writeFileSync(
      fixturePath,
      [
        `import type { ${PUBLISHED_TYPES.join(", ")} } from "${specifier}";`,
        // Bind every name so nothing is elided as an unused import.
        ...PUBLISHED_TYPES.map((name, index) => `declare const probe${index}: ${name};`),
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
      // Run from the fixture directory so the repo tsconfig is not picked up;
      // tsc refuses to combine a discovered config with explicit file args.
      { cwd: fixtureDir, encoding: "utf8" },
    );

    assert.equal(
      compiled.status,
      0,
      `consumer import of dist/runtime.js failed to compile:\n${compiled.stdout}${compiled.stderr}`,
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
