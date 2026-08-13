import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_INVALIDATION_EVENT_NAMES, listenForLiveInvalidations } from "../src/live-events";

test("live invalidations include the plural sessions event emitted by the server", () => {
  const added: string[] = [];
  const removed: string[] = [];
  const target = {
    addEventListener: (name: string) => added.push(name),
    removeEventListener: (name: string) => removed.push(name),
  };
  const listener = (() => undefined) as EventListener;
  const unsubscribe = listenForLiveInvalidations(target, listener);

  assert.deepEqual(added, [...LIVE_INVALIDATION_EVENT_NAMES]);
  assert.ok(added.includes("sessions"));
  unsubscribe();
  assert.deepEqual(removed, added);
});
