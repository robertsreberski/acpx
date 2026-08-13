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
