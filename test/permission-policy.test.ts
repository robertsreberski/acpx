import assert from "node:assert/strict";
import test from "node:test";
import { parsePermissionPolicy } from "../src/permission-policy.js";
import { PERMISSION_POLICY_ACTIONS } from "../src/types.js";

test("parsePermissionPolicy parses every rule list including defer", () => {
  const policy = parsePermissionPolicy({
    autoApprove: ["read", " search "],
    autoDeny: ["delete"],
    escalate: ["execute"],
    defer: ["fetch"],
    defaultAction: "deny",
  });

  assert.deepEqual(policy, {
    autoApprove: ["read", "search"],
    autoDeny: ["delete"],
    escalate: ["execute"],
    defer: ["fetch"],
    defaultAction: "deny",
  });
});

test("parsePermissionPolicy omits rule lists that are absent", () => {
  assert.deepEqual(parsePermissionPolicy({}), {});
  assert.deepEqual(parsePermissionPolicy({ escalate: ["execute"] }), { escalate: ["execute"] });
});

test("parsePermissionPolicy accepts an empty defer list", () => {
  assert.deepEqual(parsePermissionPolicy({ defer: [] }), { defer: [] });
});

test("parsePermissionPolicy rejects a non-array defer value", () => {
  assert.throws(
    () => parsePermissionPolicy({ defer: "fetch" }, "policy.json"),
    /policy\.json: permission policy defer must be an array of strings/,
  );
});

test("parsePermissionPolicy rejects blank defer entries", () => {
  assert.throws(
    () => parsePermissionPolicy({ defer: ["fetch", "  "] }, "policy.json"),
    /policy\.json: permission policy defer must contain only non-empty strings/,
  );
  assert.throws(
    () => parsePermissionPolicy({ defer: [7] }, "policy.json"),
    /policy\.json: permission policy defer must contain only non-empty strings/,
  );
});

test("parsePermissionPolicy accepts every declared defaultAction", () => {
  for (const action of PERMISSION_POLICY_ACTIONS) {
    assert.deepEqual(parsePermissionPolicy({ defaultAction: action }), { defaultAction: action });
  }
});

test("parsePermissionPolicy rejects an unknown defaultAction and lists the valid ones", () => {
  assert.throws(
    () => parsePermissionPolicy({ defaultAction: "postpone" }, "policy.json"),
    /policy\.json: permission policy defaultAction must be one of approve, deny, escalate, defer/,
  );
});

test("parsePermissionPolicy rejects non-object input", () => {
  assert.throws(
    () => parsePermissionPolicy([], "policy.json"),
    /policy\.json: permission policy must be a JSON object/,
  );
  assert.throws(
    () => parsePermissionPolicy(null, "policy.json"),
    /policy\.json: permission policy must be a JSON object/,
  );
});
