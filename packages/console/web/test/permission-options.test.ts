import assert from "node:assert/strict";
import test from "node:test";
import { orderPermissionOptions } from "../src/permission-options";
import type { PermissionOption } from "../src/types";

const option = (id: string, kind?: string): PermissionOption => ({ id, label: id, kind });

test("the allow-kind answer leads and every other option keeps the adapter's order", () => {
  const ordered = orderPermissionOptions([
    option("reject_once", "reject_once"),
    option("allow_always", "allow_always"),
    option("allow_once", "allow_once"),
  ]);
  assert.equal(ordered.primary?.id, "allow_always");
  assert.deepEqual(
    ordered.secondary.map((entry) => entry.id),
    ["reject_once", "allow_once"],
  );
});

test("options the console does not recognise are never dropped", () => {
  const ordered = orderPermissionOptions([option("custom_a"), option("custom_b")]);
  assert.equal(ordered.primary?.id, "custom_a");
  assert.deepEqual(
    ordered.secondary.map((entry) => entry.id),
    ["custom_b"],
  );
});

test("an agent that offered no options leaves the dock without a primary answer", () => {
  assert.deepEqual(orderPermissionOptions([]), { secondary: [] });
  assert.deepEqual(orderPermissionOptions(), { secondary: [] });
});
