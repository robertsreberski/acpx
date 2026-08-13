import { useEffect, useMemo, useRef, useState } from "react";
import { useDismissibleLayer } from "../dismissible-layer";
import { sessionGroup, useSessionStore } from "../session-store";
import { absoluteSessionTime, relativeSessionTime } from "../session-time";
import type { SessionSummary } from "../types";
import { Icon } from "./Icon";

const GROUPS = [
  { id: "needs", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "open", label: "Open" },
  { id: "history", label: "History" },
] as const;

const displayRepo = (session: SessionSummary): string =>
  session.repo ?? session.cwd.split("/").findLast(Boolean) ?? session.cwd;

const stateLabel = (session: SessionSummary): string => {
  if (session.pendingCount > 0) {
    return `${session.pendingCount} waiting`;
  }
  if (session.queuedCount > 0) {
    return `${session.queuedCount} queued`;
  }
  return session.turnState.replaceAll("_", " ");
};

export function SessionSidebar({
  open,
  onClose,
  onCreate,
  onAdopt,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreate: () => void;
  readonly onAdopt: () => void;
}) {
  const { bootstrap, connectionState, loading, selectedSessionId, selectSession } =
    useSessionStore();
  const sidebarLayerRef = useRef<HTMLDivElement>(null);
  useDismissibleLayer(open, onClose, sidebarLayerRef);
  const [query, setQuery] = useState("");
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setRelativeTimeNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = bootstrap.sessions.filter(
      (session) =>
        !needle ||
        [session.name, session.agentLabel, session.cwd, session.repo, session.branch].some(
          (value) => value?.toLocaleLowerCase().includes(needle),
        ),
    );
    return new Map(
      GROUPS.map((group) => [
        group.id,
        filtered.filter((session) => sessionGroup(session) === group.id),
      ]),
    );
  }, [bootstrap.sessions, query]);

  return (
    <div ref={sidebarLayerRef} className="sidebar-layer">
      <aside
        id="session-sidebar"
        className={`session-sidebar${open ? " is-open" : ""}`}
        role={open ? "dialog" : undefined}
        aria-modal={open ? "true" : undefined}
        aria-label="Coding sessions"
      >
        <header className="sidebar-header">
          <div className="product-mark" aria-hidden="true">
            A
          </div>
          <div>
            <strong>ACPX Console</strong>
            <span>Coding sessions</span>
          </div>
          <button
            className="icon-button mobile-only"
            type="button"
            aria-label="Close sessions"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="sidebar-actions">
          <button type="button" className="primary-button" onClick={onCreate}>
            <Icon name="plus" size={16} /> New session
          </button>
          <button type="button" className="secondary-button" onClick={onAdopt}>
            Adopt session
          </button>
        </div>
        <label className="session-search">
          <Icon name="search" size={15} />
          <span className="sr-only">Search sessions</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions"
          />
        </label>
        <nav className="session-groups" aria-label="Session list">
          {loading && bootstrap.sessions.length === 0 && (
            <p className="sidebar-empty">Loading sessions…</p>
          )}
          {!loading && bootstrap.sessions.length === 0 && (
            <p className="sidebar-empty">No sessions yet.</p>
          )}
          {GROUPS.map((group) => {
            const sessions = groups.get(group.id) ?? [];
            if (sessions.length === 0) {
              return null;
            }
            return (
              <section className="session-group" key={group.id}>
                <h2>
                  {group.label}
                  <span>{sessions.length}</span>
                </h2>
                <ul>
                  {sessions.map((session) => (
                    <li key={session.id}>
                      <button
                        type="button"
                        className={`session-row${selectedSessionId === session.id ? " is-selected" : ""}`}
                        aria-current={selectedSessionId === session.id ? "page" : undefined}
                        onClick={() => {
                          selectSession(session.id);
                          onClose();
                        }}
                      >
                        <span className={`state-dot is-${sessionGroup(session)}`} />
                        <span className="session-row-copy">
                          <strong>{session.name || displayRepo(session)}</strong>
                          <span>
                            {displayRepo(session)} · {session.agentLabel}
                          </span>
                          <span className="session-row-meta">
                            <em>{stateLabel(session)}</em>
                            <time
                              dateTime={session.lastActivityAt}
                              title={absoluteSessionTime(session.lastActivityAt)}
                              aria-label={`Last activity: ${absoluteSessionTime(session.lastActivityAt)}`}
                            >
                              {relativeSessionTime(session.lastActivityAt, relativeTimeNow)}
                            </time>
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {query && [...groups.values()].every((sessions) => sessions.length === 0) && (
            <p className="sidebar-empty">No sessions match “{query}”.</p>
          )}
        </nav>
        <footer className="sidebar-footer">
          <span
            className={`connection-dot${loading || connectionState === "connecting" ? " is-loading" : connectionState === "offline" ? " is-offline" : ""}`}
          />
          {connectionState === "offline"
            ? "Live updates disconnected"
            : loading || connectionState === "connecting"
              ? "Refreshing…"
              : `${bootstrap.sessions.length} local session${bootstrap.sessions.length === 1 ? "" : "s"}`}
        </footer>
      </aside>
      {open && <button className="sidebar-scrim" aria-label="Close sessions" onClick={onClose} />}
    </div>
  );
}
