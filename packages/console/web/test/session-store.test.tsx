import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement, useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { api, ApiError } from "../src/api";
import { SessionStoreProvider, useSessionStore } from "../src/session-store";
import type { PendingInteraction, SessionDetail, TimelinePage } from "../src/types";

Object.assign(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }, {
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.assign(globalThis, { React });

const SESSION: SessionDetail = {
  id: "record-1",
  name: "Retained session",
  agentId: "codex",
  agentLabel: "Codex",
  cwd: "/tmp/work",
  sessionState: "open",
  ownerState: "online",
  turnState: "idle",
  pendingCount: 1,
  queuedCount: 0,
  queuedTurns: [],
  createdAt: "2026-08-13T10:00:00.000Z",
  updatedAt: "2026-08-13T10:01:00.000Z",
  lastActivityAt: "2026-08-13T10:01:00.000Z",
  modeState: "unmanaged",
};

const TIMELINE: TimelinePage = {
  epoch: "epoch-1",
  coverage: "complete",
  events: [
    {
      id: "event-1",
      sequence: 1,
      occurredAt: "2026-08-13T10:00:30.000Z",
      kind: "message",
      role: "assistant",
      text: "History is visible before another prompt.",
    },
  ],
};

const PENDING: PendingInteraction = {
  id: "request-1",
  sessionId: SESSION.id,
  kind: "permission",
  state: "pending",
  createdAt: "2026-08-13T10:00:45.000Z",
  title: "Run command",
};

test("selection keeps detail and transcript when pending fails, then retries pending", async () => {
  const restoreBrowser = installBrowser(`/sessions/${SESSION.id}`);
  const restoreApi = stubApi();
  let pendingReads = 0;
  let snapshot: ReturnType<typeof useSessionStore> | undefined;

  Object.defineProperties(api, {
    bootstrap: {
      configurable: true,
      value: async () => ({ agents: [], workspaceRoots: [], sessions: [SESSION] }),
    },
    session: { configurable: true, value: async () => SESSION },
    timeline: { configurable: true, value: async () => TIMELINE },
    pending: {
      configurable: true,
      value: async () => {
        pendingReads += 1;
        if (pendingReads === 1) {
          throw new ApiError("pending endpoint unavailable", 503);
        }
        return [PENDING];
      },
    },
  });

  function Harness() {
    const store = useSessionStore();
    useEffect(() => {
      snapshot = store;
    });
    return createElement("div", null, store.timeline?.events[0]?.text ?? "no transcript");
  }

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = createWithoutDeprecationWarning(
        createElement(SessionStoreProvider, null, createElement(Harness)),
      );
      await flushReactWork();
    });

    assert.equal(snapshot?.selectedSession?.id, SESSION.id);
    assert.equal(snapshot?.timeline?.events[0]?.text, TIMELINE.events[0]?.text);
    assert.deepEqual(renderer?.toJSON(), {
      type: "div",
      props: {},
      children: ["History is visible before another prompt."],
    });
    assert.deepEqual(snapshot?.pending, []);
    assert.match(
      snapshot?.notices.at(-1)?.message ?? "",
      /Pending requests could not be refreshed: pending endpoint unavailable/u,
    );

    await act(async () => {
      await snapshot?.refresh();
      await flushReactWork();
    });

    assert.equal(pendingReads, 2);
    assert.equal(snapshot?.selectedSession?.id, SESSION.id);
    assert.equal(snapshot?.timeline?.events[0]?.text, TIMELINE.events[0]?.text);
    assert.deepEqual(snapshot?.pending, [PENDING]);
  } finally {
    await act(async () => {
      renderer?.unmount();
      await flushReactWork();
    });
    restoreApi();
    restoreBrowser();
  }
});

const flushReactWork = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const createWithoutDeprecationWarning = (
  element: Parameters<typeof create>[0],
): ReactTestRenderer => {
  const originalError = console.error;
  console.error = ((message?: unknown, ...args: unknown[]) => {
    if (typeof message === "string" && message.includes("react-test-renderer is deprecated")) {
      return;
    }
    originalError(message, ...args);
  }) as typeof console.error;
  try {
    return create(element);
  } finally {
    console.error = originalError;
  }
};

const stubApi = (): (() => void) => {
  const names = ["bootstrap", "session", "timeline", "pending"] as const;
  const descriptors = Object.fromEntries(
    names.map((name) => [name, Object.getOwnPropertyDescriptor(api, name)]),
  );
  return () => {
    for (const name of names) {
      const descriptor = descriptors[name];
      if (descriptor) {
        Object.defineProperty(api, name, descriptor);
      } else {
        delete (api as unknown as Record<string, unknown>)[name];
      }
    }
  };
};

class FakeEventSource {
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

const installBrowser = (pathname: string): (() => void) => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousEventSource = (globalThis as { EventSource?: unknown }).EventSource;
  const location = new URL(`http://127.0.0.1:4174${pathname}`);
  const listeners = new Map<string, Set<EventListener>>();
  (globalThis as { window?: unknown }).window = {
    location,
    history: {
      pushState: (_state: unknown, _title: string, next: string) => {
        location.pathname = new URL(next, location).pathname;
      },
      replaceState: (_state: unknown, _title: string, next: string) => {
        location.pathname = new URL(next, location).pathname;
      },
    },
    addEventListener: (type: string, listener: EventListener) => {
      const current = listeners.get(type) ?? new Set<EventListener>();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    },
    setTimeout,
    clearTimeout,
  };
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  return () => {
    if (previousWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = previousWindow;
    }
    if (previousEventSource === undefined) {
      delete (globalThis as { EventSource?: unknown }).EventSource;
    } else {
      (globalThis as { EventSource?: unknown }).EventSource = previousEventSource;
    }
  };
};
