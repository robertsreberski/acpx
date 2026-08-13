import assert from "node:assert/strict";
import test from "node:test";
import { HttpError, InFlightRequestLimiter, MutationRateLimiter } from "../src/security.js";

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

test("in-flight limiter enforces per-client and global capacity, then releases slots", async () => {
  const limiter = new InFlightRequestLimiter(2, 1);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = limiter.run("one", async () => await pending);
  const second = limiter.run("two", async () => await pending);
  await assert.rejects(
    limiter.run("one", async () => undefined),
    (error: unknown) => error instanceof HttpError && error.code === "PROVIDER_ENUMERATION_LIMIT",
  );
  await assert.rejects(
    limiter.run("three", async () => undefined),
    (error: unknown) =>
      error instanceof HttpError && error.code === "PROVIDER_ENUMERATION_CAPACITY",
  );
  assert.equal(limiter.activeCount, 2);
  release();
  await Promise.all([first, second]);
  assert.equal(limiter.activeCount, 0);
  await limiter.run("three", async () => undefined);
});
