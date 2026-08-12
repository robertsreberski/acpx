import assert from "node:assert/strict";
import test from "node:test";
import { RequestGeneration } from "../src/request-generation";

test("only the newest overlapping request can commit its response", () => {
  const requests = new RequestGeneration();
  const slow = requests.begin();
  const fast = requests.begin();

  assert.equal(requests.isLatest(fast), true);
  assert.equal(requests.isLatest(slow), false);

  const newest = requests.begin();
  assert.equal(requests.isLatest(fast), false);
  assert.equal(requests.isLatest(newest), true);
});
