import fs from "node:fs/promises";
import path from "node:path";
import {
  PERMISSION_POLICY_ACTIONS,
  PERMISSION_POLICY_RULE_KEYS,
  type PermissionPolicy,
  type PermissionPolicyAction,
  type PermissionPolicyRuleKey,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseRuleList(value: unknown, key: string, source: string): string[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${source}: permission policy ${key} must be an array of strings`);
  }

  const parsed = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${source}: permission policy ${key} must contain only non-empty strings`);
    }
    return entry.trim();
  });

  return parsed;
}

function isPermissionPolicyAction(value: unknown): value is PermissionPolicyAction {
  return (
    typeof value === "string" && PERMISSION_POLICY_ACTIONS.includes(value as PermissionPolicyAction)
  );
}

function parseDefaultAction(
  value: unknown,
  source: string,
): PermissionPolicy["defaultAction"] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!isPermissionPolicyAction(value)) {
    throw new Error(
      `${source}: permission policy defaultAction must be one of ${PERMISSION_POLICY_ACTIONS.join(", ")}`,
    );
  }
  return value;
}

function assignRuleList(
  policy: PermissionPolicy,
  key: PermissionPolicyRuleKey,
  value: string[] | undefined,
): void {
  if (value) {
    policy[key] = value;
  }
}

export function parsePermissionPolicy(
  value: unknown,
  source = "permission policy",
): PermissionPolicy {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${source}: permission policy must be a JSON object`);
  }

  const policy: PermissionPolicy = {};
  for (const key of PERMISSION_POLICY_RULE_KEYS) {
    assignRuleList(policy, key, parseRuleList(record[key], key, source));
  }

  const defaultAction = parseDefaultAction(record.defaultAction, source);
  if (defaultAction) {
    policy.defaultAction = defaultAction;
  }

  return policy;
}

export async function loadPermissionPolicySpec(
  spec: string | undefined,
  cwd: string,
): Promise<PermissionPolicy | undefined> {
  const trimmed = spec?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("{")) {
    return parsePermissionPolicy(JSON.parse(trimmed), "--permission-policy");
  }

  const policyPath = path.resolve(cwd, trimmed);
  const raw = await fs.readFile(policyPath, "utf8");
  return parsePermissionPolicy(JSON.parse(raw), policyPath);
}
