import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useDismissibleLayer } from "../dismissible-layer";
import {
  displayRepo,
  groupSessionsByRepo,
  harnessLine,
  modeBadge,
  sessionStatus,
} from "../session-presentation";
import { sessionGroup, useSessionStore } from "../session-store";
import { absoluteSessionTime, compactSessionTime } from "../session-time";
import type { HiddenWorkspace, SessionSummary } from "../types";
import { Icon } from "./Icon";

/** Live and waiting work stays on screen; finished and idle sessions collapse. */
const isLiveWork = (session: SessionSummary): boolean => {
  const group = sessionGroup(session);
  return group === "needs" || group === "working";
};

const matchesQuery = (session: SessionSummary, needle: string): boolean =>
  !needle ||
  [session.name, session.agentLabel, session.cwd, session.repo, session.branch, session.model].some(
    (value) => value?.toLocaleLowerCase().includes(needle),
  );

function SessionRow({
  session,
  selected,
  now,
  onSelect,
}: {
  readonly session: SessionSummary;
  readonly selected: boolean;
  readonly now: number;
  readonly onSelect: () => void;
}) {
  const badge = modeBadge(session);
  const status = sessionStatus(session);
  const harness = harnessLine(session);
  return (
    <button
      type="button"
      className={`session-row${selected ? " is-selected" : ""}`}
      aria-current={selected ? "page" : undefined}
      onClick={onSelect}
    >
      <span className="session-row-head">
        <strong>{session.name || displayRepo(session)}</strong>
        <time
          dateTime={session.lastActivityAt}
          title={absoluteSessionTime(session.lastActivityAt)}
          aria-label={`Last activity: ${absoluteSessionTime(session.lastActivityAt)}`}
        >
          {compactSessionTime(session.lastActivityAt, now)}
        </time>
      </span>
      <span className="session-row-state">
        {badge && (
          <span className={`mode-badge${badge.canWrite ? " is-write" : ""}`}>{badge.label}</span>
        )}
        <span className={`session-row-status is-${status.tone}`}>
          <i className={`state-dot is-${status.tone}`} />
          {status.text}
        </span>
      </span>
      {harness && <span className="session-row-harness">{harness}</span>}
    </button>
  );
}

/**
 * Account for the sessions the console declined to serve.
 *
 * The admission rule does not change here — work outside a configured root
 * still stays out until the operator grants it. What changes is that the
 * omission is now visible: a short list with no explanation is indistinguishable
 * from having no other work, and a session the operator cannot see is one they
 * cannot recover.
 *
 * A deleted workspace gets no Authorize button, because no grant can resolve a
 * directory that is gone; naming it is the whole remedy the console can offer.
 */
function HiddenWorkspaces({
  workspaces,
  onAuthorized,
}: {
  readonly workspaces: readonly HiddenWorkspace[];
  readonly onAuthorized: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [authorizing, setAuthorizing] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  if (workspaces.length === 0) {
    return null;
  }
  const total = workspaces.reduce((count, workspace) => count + workspace.sessionCount, 0);
  const authorize = async (path: string): Promise<void> => {
    setAuthorizing(path);
    setFailure(null);
    try {
      await api.authorizeWorkspace(path);
      await onAuthorized();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthorizing(null);
    }
  };
  return (
    <section className="hidden-workspaces">
      <button
        type="button"
        className="show-done"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {total} session{total === 1 ? "" : "s"} not shown
        <Icon name="chevron" size={16} />
      </button>
      {expanded && (
        <ul>
          {workspaces.map((workspace) => (
            <li key={workspace.path}>
              <p className="hidden-workspace-path">{workspace.path}</p>
              <p className="hidden-workspace-note">
                {workspace.sessionCount} session{workspace.sessionCount === 1 ? "" : "s"} ·{" "}
                {workspace.reason === "missing"
                  ? "workspace no longer exists"
                  : "outside the allowed workspaces"}
              </p>
              {workspace.reason === "unauthorized" && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={authorizing !== null}
                  onClick={() => void authorize(workspace.path)}
                >
                  {authorizing === workspace.path ? "Authorizing…" : "Authorize"}
                </button>
              )}
            </li>
          ))}
          {failure && <li className="hidden-workspace-error">{failure}</li>}
        </ul>
      )}
    </section>
  );
}

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
  const { bootstrap, connectionState, loading, refresh, selectedSessionId, selectSession } =
    useSessionStore();
  const sidebarLayerRef = useRef<HTMLDivElement>(null);
  useDismissibleLayer(open, onClose, sidebarLayerRef);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setRelativeTimeNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const { live, done, repos } = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matched = bootstrap.sessions.filter((session) => matchesQuery(session, needle));
    const liveSessions = matched.filter(isLiveWork);
    const counts = new Map<string, number>();
    for (const session of liveSessions) {
      const repo = displayRepo(session);
      counts.set(repo, (counts.get(repo) ?? 0) + 1);
    }
    const inFilter = (session: SessionSummary) =>
      repoFilter === null || displayRepo(session) === repoFilter;
    return {
      live: groupSessionsByRepo(liveSessions.filter(inFilter)),
      done: matched.filter((session) => !isLiveWork(session)).filter(inFilter),
      repos: [...counts.entries()].toSorted((left, right) => left[0].localeCompare(right[0])),
    };
  }, [bootstrap.sessions, query, repoFilter]);

  // A filtered-away repo would otherwise leave the list permanently empty.
  useEffect(() => {
    if (repoFilter !== null && !repos.some(([repo]) => repo === repoFilter)) {
      setRepoFilter(null);
    }
  }, [repoFilter, repos]);

  const liveCount = repos.reduce((total, [, count]) => total + count, 0);
  const nothingMatches = live.length === 0 && done.length === 0;
  const select = (id: string) => {
    selectSession(id);
    onClose();
  };

  return (
    <div ref={sidebarLayerRef} className="sidebar-layer">
      <aside
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
            <span className="sidebar-status">
              <i
                className={`connection-dot${loading || connectionState === "connecting" ? " is-loading" : connectionState === "offline" ? " is-offline" : ""}`}
              />
              {connectionState === "offline"
                ? "Live updates disconnected"
                : loading || connectionState === "connecting"
                  ? "Refreshing…"
                  : `${bootstrap.sessions.length} local session${bootstrap.sessions.length === 1 ? "" : "s"}`}
            </span>
          </div>
          <button
            type="button"
            className="icon-button sidebar-search-toggle"
            aria-label={searchOpen ? "Hide session search" : "Search sessions"}
            aria-expanded={searchOpen}
            onClick={() => setSearchOpen((value) => !value)}
          >
            <Icon name="search" size={20} />
          </button>
          <button
            className="icon-button mobile-only"
            type="button"
            aria-label="Close sessions"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <label className={`session-search${searchOpen ? " is-open" : ""}`}>
          <Icon name="search" size={18} />
          <span className="sr-only">Search sessions</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions"
          />
        </label>
        {/* An active filter always keeps its chip row: with one live project
            left, hiding the row would strand the user filtered with no way to
            clear it. */}
        {(repos.length > 1 || repoFilter !== null) && (
          <div className="repo-filters" role="group" aria-label="Filter by project">
            <button
              type="button"
              className={`repo-chip${repoFilter === null ? " is-active" : ""}`}
              aria-pressed={repoFilter === null}
              onClick={() => setRepoFilter(null)}
            >
              All<span>{liveCount}</span>
            </button>
            {repos.map(([repo, count]) => (
              <button
                type="button"
                key={repo}
                className={`repo-chip${repoFilter === repo ? " is-active" : ""}`}
                aria-pressed={repoFilter === repo}
                onClick={() => setRepoFilter(repo)}
              >
                {repo}
                <span>{count}</span>
              </button>
            ))}
          </div>
        )}
        <nav className="session-groups" aria-label="Session list">
          {loading && bootstrap.sessions.length === 0 && (
            <p className="sidebar-empty">Loading sessions…</p>
          )}
          {!loading && bootstrap.sessions.length === 0 && (
            <p className="sidebar-empty">No sessions yet.</p>
          )}
          {live.map((group) => (
            <section className="session-group" key={group.repo}>
              <h2>{group.repo}</h2>
              <ul>
                {group.sessions.map((session) => (
                  <li key={session.id}>
                    <SessionRow
                      session={session}
                      selected={selectedSessionId === session.id}
                      now={relativeTimeNow}
                      onSelect={() => select(session.id)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {done.length > 0 && (
            <section className="session-done">
              <button
                type="button"
                className="show-done"
                aria-expanded={showDone}
                onClick={() => setShowDone((value) => !value)}
              >
                {showDone ? "Hide" : "Show"} {done.length} done
                <Icon name="chevron" size={16} />
              </button>
              {showDone && (
                <ul>
                  {done.map((session) => (
                    <li key={session.id}>
                      <SessionRow
                        session={session}
                        selected={selectedSessionId === session.id}
                        now={relativeTimeNow}
                        onSelect={() => select(session.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {bootstrap.sessions.length > 0 && nothingMatches && (
            <p className="sidebar-empty">
              {query ? `No sessions match “${query}”.` : "No sessions in this project."}
            </p>
          )}
          <HiddenWorkspaces workspaces={bootstrap.hiddenWorkspaces} onAuthorized={refresh} />
        </nav>
        <div className="sidebar-actions">
          <button type="button" className="primary-button" onClick={onCreate}>
            <Icon name="plus" size={18} /> New session
          </button>
          <button type="button" className="ghost-button" onClick={onAdopt}>
            Adopt
          </button>
        </div>
      </aside>
      {open && <button className="sidebar-scrim" aria-label="Close sessions" onClick={onClose} />}
    </div>
  );
}
