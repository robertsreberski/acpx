import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// These assertions run against the BUILT artifact, not src. A symbol can exist
// in src, typecheck fine, and still be unreachable for anyone installing the
// package — which is exactly how matchPermissionPolicy shipped "exported" while
// dist/runtime.js never listed it.
const DIST_RUNTIME_URL = new URL("../../dist/runtime.js", import.meta.url);
const DIST_RUNTIME_TYPES_PATH = fileURLToPath(new URL("../../dist/runtime.d.ts", import.meta.url));

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

test("dist/runtime.d.ts names the permission policy types consumers need", () => {
  const declarations = readFileSync(DIST_RUNTIME_TYPES_PATH, "utf8");

  for (const name of PUBLISHED_TYPES) {
    assert.match(
      declarations,
      new RegExp(`\\btype ${name}\\b`),
      `dist/runtime.d.ts does not name type ${name}`,
    );
  }
});
