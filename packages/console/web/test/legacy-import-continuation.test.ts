import assert from "node:assert/strict";
import test from "node:test";
import { continueLegacyTimelineImport } from "../src/legacy-import-continuation";
import type { TimelinePage } from "../src/types";

const page = (pending: boolean, sequence: number): TimelinePage => ({
  epoch: "epoch-1",
  events: [
    {
      id: `event:epoch-1:${sequence}`,
      epoch: "epoch-1",
      sequence,
      occurredAt: "2026-08-13T12:00:00.000Z",
      kind: "message",
      role: "assistant",
      text: String(sequence),
    },
  ],
  coverage: "legacy_retained",
  ...(pending ? { legacyImportPending: true as const } : {}),
});

test("bounded legacy transcript passes continue without a prompt or live event", async () => {
  const pages = [page(true, 2), page(false, 3)];
  const applied: TimelinePage[] = [];
  let loads = 0;
  await continueLegacyTimelineImport({
    active: () => true,
    wait: async () => undefined,
    load: async () => {
      loads += 1;
      const next = pages.shift();
      assert(next);
      return next;
    },
    apply: (next) => applied.push(next),
  });

  assert.equal(loads, 2);
  assert.deepEqual(
    applied.map((entry) => entry.events[0]?.sequence),
    [2, 3],
  );
});

test("changing the active selection stops before another transcript request", async () => {
  let active = true;
  let loads = 0;
  await continueLegacyTimelineImport({
    active: () => active,
    wait: async () => {
      active = false;
    },
    load: async () => {
      loads += 1;
      return page(false, 2);
    },
    apply: () => assert.fail("a stale selection must not be updated"),
  });

  assert.equal(loads, 0);
});

test("a transient read failure retries and still completes retained history", async () => {
  const delays: number[] = [];
  const errors: unknown[] = [];
  let loads = 0;
  await continueLegacyTimelineImport({
    active: () => true,
    wait: async (delayMs) => {
      delays.push(delayMs);
    },
    load: async () => {
      loads += 1;
      if (loads === 1) {
        throw new Error("offline");
      }
      return page(false, 2);
    },
    apply: () => undefined,
    onError: (error) => {
      errors.push(error);
      return true;
    },
  });

  assert.equal(loads, 2);
  assert.deepEqual(delays, [16, 250]);
  assert.equal(errors.length, 1);
});

test("selection invalidation during an in-flight read ignores the stale page", async () => {
  let active = true;
  let release!: (value: TimelinePage) => void;
  const loaded = new Promise<TimelinePage>((resolve) => {
    release = resolve;
  });
  let applied = 0;
  const continuation = continueLegacyTimelineImport({
    active: () => active,
    wait: async () => undefined,
    load: async () => await loaded,
    apply: () => {
      applied += 1;
    },
  });
  await Promise.resolve();
  active = false;
  release(page(false, 2));
  await continuation;
  assert.equal(applied, 0);
});
