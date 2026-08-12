import assert from "node:assert/strict";
import test from "node:test";
import { HttpError, MutationRateLimiter } from "../src/security.js";

test("mutation limiter caps distinct clients and evicts expired buckets", () => {
  let now = 1_000;
  const limiter = new MutationRateLimiter(2, 100, () => now, 2);
  limiter.check("one");
  limiter.check("two");
  assert.equal(limiter.clientCount, 2);
  assert.throws(
    () => limiter.check("three"),
    (error: unknown) => error instanceof HttpError && error.code === "RATE_LIMIT_CAPACITY",
  );
  now += 101;
  limiter.check("three");
  assert.equal(limiter.clientCount, 1);
});
