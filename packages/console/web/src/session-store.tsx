import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, ApiError } from "./api";
import { listenForLiveInvalidations } from "./live-events";
import {
  mergeRefreshedTimelinePage,
  normalizeTimelinePage,
  prependEarlierTimelinePage,
} from "./timeline-pages";
import type {
  AdoptSessionInput,
  BootstrapSnapshot,
  ConsoleNotice,
  CreateSessionInput,
  MutationReceipt,
  PendingInteraction,
  SessionDetail,
  SessionSummary,
  TimelinePage,
} from "./types";

const EMPTY_BOOTSTRAP: BootstrapSnapshot = { agents: [], workspaceRoots: [], sessions: [] };

const selectedSessionFromLocation = (): string | null => {
  const match = /^\/sessions\/([^/]+)\/?$/u.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1] ?? "") : null;
};

interface SessionStoreValue {
  readonly bootstrap: BootstrapSnapshot;
  readonly loading: boolean;
  readonly selectedSessionId: string | null;
  readonly selectedSession: SessionDetail | null;
  readonly timeline: TimelinePage | null;
  readonly pending: readonly PendingInteraction[];
  readonly notices: readonly ConsoleNotice[];
  readonly actionBusy: boolean;
  readonly selectSession: (id: string | null) => void;
  readonly refresh: () => Promise<void>;
  readonly loadEarlier: () => Promise<void>;
  readonly sendPrompt: (text: string) => Promise<MutationReceipt>;
  readonly cancelTurn: () => Promise<void>;
  readonly closeSession: () => Promise<void>;
  readonly answerInteraction: (requestId: string, answer: unknown) => Promise<void>;
  readonly createSession: (input: CreateSessionInput) => Promise<SessionDetail>;
  readonly adoptSession: (input: AdoptSessionInput) => Promise<SessionDetail>;
  readonly dismissNotice: (id: number) => void;
}

const SessionStore = createContext<SessionStoreValue | null>(null);

const errorMessage = (error: unknown): string =>
  error instanceof ApiError || error instanceof Error ? error.message : "The request failed.";

export function SessionStoreProvider({ children }: { readonly children: ReactNode }) {
  const [bootstrap, setBootstrap] = useState<BootstrapSnapshot>(EMPTY_BOOTSTRAP);
  const [loading, setLoading] = useState(true);
  const [selectedSessionId, setSelectedSessionId] = useState(selectedSessionFromLocation);
  const [selectedSession, setSelectedSession] = useState<SessionDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelinePage | null>(null);
  const [pending, setPending] = useState<readonly PendingInteraction[]>([]);
  const [notices, setNotices] = useState<readonly ConsoleNotice[]>([]);
  const [actionBusy, setActionBusy] = useState(false);
  const noticeId = useRef(0);
  const selectionGeneration = useRef(0);
  const refreshTimer = useRef<number | undefined>(undefined);

  const notice = useCallback((message: string, tone: ConsoleNotice["tone"] = "error") => {
    const id = ++noticeId.current;
    setNotices((current) => [...current.slice(-3), { id, message, tone }]);
  }, []);

  const refreshBootstrap = useCallback(async () => {
    try {
      const snapshot = await api.bootstrap();
      api.setCsrfToken(snapshot.csrfToken);
      setBootstrap(snapshot);
    } catch (error) {
      notice(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [notice]);

  const refreshSelection = useCallback(
    async (id: string, preserveLoadedHistory = true) => {
      const generation = ++selectionGeneration.current;
      try {
        const [detail, page, interactions] = await Promise.all([
          api.session(id),
          api.timeline(id),
          api.pending(id),
        ]);
        if (generation !== selectionGeneration.current) {
          return;
        }
        setSelectedSession(detail);
        setTimeline((current) =>
          preserveLoadedHistory
            ? mergeRefreshedTimelinePage(current, page)
            : normalizeTimelinePage(page),
        );
        setPending(interactions);
      } catch (error) {
        if (generation !== selectionGeneration.current) {
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          setSelectedSessionId(null);
          window.history.replaceState(null, "", "/");
        }
        notice(errorMessage(error));
      }
    },
    [notice],
  );

  const refresh = useCallback(async () => {
    await refreshBootstrap();
    if (selectedSessionId) {
      await refreshSelection(selectedSessionId);
    }
  }, [refreshBootstrap, refreshSelection, selectedSessionId]);

  useEffect(() => {
    void refreshBootstrap();
  }, [refreshBootstrap]);

  useEffect(() => {
    selectionGeneration.current += 1;
    setSelectedSession(null);
    setTimeline(null);
    setPending([]);
    if (selectedSessionId) {
      void refreshSelection(selectedSessionId, false);
    }
  }, [refreshSelection, selectedSessionId]);

  useEffect(() => {
    const onPopState = () => {
      selectionGeneration.current += 1;
      setSelectedSessionId(selectedSessionFromLocation());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const events = new EventSource("/api/v1/events");
    const invalidate = () => {
      if (refreshTimer.current !== undefined) {
        window.clearTimeout(refreshTimer.current);
      }
      refreshTimer.current = window.setTimeout(() => void refresh(), 80);
    };
    const stopListening = listenForLiveInvalidations(events, invalidate);
    return () => {
      stopListening();
      events.close();
      if (refreshTimer.current !== undefined) {
        window.clearTimeout(refreshTimer.current);
      }
    };
  }, [refresh]);

  const selectSession = useCallback((id: string | null) => {
    selectionGeneration.current += 1;
    setSelectedSessionId(id);
    window.history.pushState(null, "", id ? `/sessions/${encodeURIComponent(id)}` : "/");
  }, []);

  const loadEarlier = useCallback(async () => {
    if (!selectedSessionId || !timeline?.previousCursor) {
      return;
    }
    const sessionId = selectedSessionId;
    const generation = selectionGeneration.current;
    const previousCursor = timeline.previousCursor;
    try {
      const page = await api.timeline(sessionId, previousCursor);
      if (generation !== selectionGeneration.current) {
        return;
      }
      setTimeline((current) =>
        current ? prependEarlierTimelinePage(current, page) : normalizeTimelinePage(page),
      );
    } catch (error) {
      if (generation !== selectionGeneration.current) {
        return;
      }
      if (error instanceof ApiError && error.status === 410) {
        notice(
          "Earlier transcript pages expired. Reloading from the earliest available event.",
          "info",
        );
        await refreshSelection(sessionId, false);
        return;
      }
      notice(errorMessage(error));
    }
  }, [notice, refreshSelection, selectedSessionId, timeline]);

  const runAction = useCallback(
    async <T,>(action: () => Promise<T>, success?: string): Promise<T> => {
      setActionBusy(true);
      try {
        const result = await action();
        if (success) {
          notice(success, "success");
        }
        await refresh();
        return result;
      } catch (error) {
        notice(errorMessage(error));
        throw error;
      } finally {
        setActionBusy(false);
      }
    },
    [notice, refresh],
  );

  const sendPrompt = useCallback(
    async (text: string) => {
      if (!selectedSessionId) {
        throw new Error("Select a session first.");
      }
      return await runAction(
        () => api.sendPrompt(selectedSessionId, text),
        selectedSession?.turnState === "idle" ? "Prompt started." : "Follow-up queued.",
      );
    },
    [runAction, selectedSession?.turnState, selectedSessionId],
  );

  const cancelTurn = useCallback(async () => {
    if (!selectedSessionId || !selectedSession?.activeTurnId) {
      return;
    }
    const activeTurnId = selectedSession.activeTurnId;
    await runAction(
      () => api.cancelTurn(selectedSessionId, activeTurnId),
      "Cancellation requested.",
    );
  }, [runAction, selectedSession, selectedSessionId]);

  const closeSession = useCallback(async () => {
    if (!selectedSessionId) {
      return;
    }
    await runAction(() => api.closeSession(selectedSessionId), "Session closed.");
  }, [runAction, selectedSessionId]);

  const answerInteraction = useCallback(
    async (requestId: string, answer: unknown) => {
      if (!selectedSessionId) {
        return;
      }
      await runAction(
        () => api.answerInteraction(selectedSessionId, requestId, answer),
        "Answer delivered.",
      );
    },
    [runAction, selectedSessionId],
  );

  const createSession = useCallback(
    async (input: CreateSessionInput) => {
      const session = await runAction(() => api.createSession(input), "Session created.");
      selectSession(session.id);
      return session;
    },
    [runAction, selectSession],
  );

  const adoptSession = useCallback(
    async (input: AdoptSessionInput) => {
      const session = await runAction(() => api.adoptSession(input), "Session adopted.");
      selectSession(session.id);
      return session;
    },
    [runAction, selectSession],
  );

  const value = useMemo<SessionStoreValue>(
    () => ({
      bootstrap,
      loading,
      selectedSessionId,
      selectedSession,
      timeline,
      pending,
      notices,
      actionBusy,
      selectSession,
      refresh,
      loadEarlier,
      sendPrompt,
      cancelTurn,
      closeSession,
      answerInteraction,
      createSession,
      adoptSession,
      dismissNotice: (id) => setNotices((current) => current.filter((item) => item.id !== id)),
    }),
    [
      actionBusy,
      adoptSession,
      answerInteraction,
      bootstrap,
      cancelTurn,
      closeSession,
      createSession,
      loadEarlier,
      loading,
      notices,
      pending,
      refresh,
      selectSession,
      selectedSession,
      selectedSessionId,
      sendPrompt,
      timeline,
    ],
  );

  return <SessionStore.Provider value={value}>{children}</SessionStore.Provider>;
}

export const useSessionStore = (): SessionStoreValue => {
  const value = useContext(SessionStore);
  if (!value) {
    throw new Error("useSessionStore must be used inside SessionStoreProvider.");
  }
  return value;
};

export const sessionGroup = (session: SessionSummary): "needs" | "working" | "open" | "history" => {
  if (
    session.pendingCount > 0 ||
    session.turnState === "waiting_permission" ||
    session.turnState === "waiting_elicitation"
  ) {
    return "needs";
  }
  if (["queued", "starting", "running", "cancelling"].includes(session.turnState)) {
    return "working";
  }
  if (session.sessionState === "open") {
    return "open";
  }
  return "history";
};
