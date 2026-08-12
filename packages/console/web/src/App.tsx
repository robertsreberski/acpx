import { useState } from "react";
import { Icon } from "./components/Icon";
import { SessionDialog } from "./components/SessionDialog";
import { SessionFacts } from "./components/SessionFacts";
import { SessionSidebar } from "./components/SessionSidebar";
import { Transcript } from "./components/Transcript";
import { AcpxRuntimeProvider } from "./runtime";
import { useSessionStore } from "./session-store";

const turnLabel = (state: string): string => state.replaceAll("_", " ");

function Welcome({
  onCreate,
  onAdopt,
}: {
  readonly onCreate: () => void;
  readonly onAdopt: () => void;
}) {
  return (
    <main className="welcome-panel">
      <div className="welcome-mark">A</div>
      <h1>Your coding sessions, in one place</h1>
      <p>
        Create an ACPX session or adopt existing agent work. Watch the complete transcript, answer
        requests, and queue what comes next.
      </p>
      <div>
        <button type="button" className="primary-button" onClick={onCreate}>
          <Icon name="plus" size={16} /> New session
        </button>
        <button type="button" className="secondary-button" onClick={onAdopt}>
          Adopt session
        </button>
      </div>
    </main>
  );
}

export default function App() {
  const store = useSessionStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [factsOpen, setFactsOpen] = useState(false);
  const [dialog, setDialog] = useState<"create" | "adopt" | null>(null);
  const session = store.selectedSession;

  return (
    <div className="app-shell">
      {store.bootstrap.trustNetwork && (
        <div className="network-warning" role="status">
          <strong>Trusted network mode:</strong> anyone who can reach this console has full control
          of your ACPX sessions.
        </div>
      )}
      <div className="app-body">
        <SessionSidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onCreate={() => setDialog("create")}
          onAdopt={() => setDialog("adopt")}
        />
        <section className={`session-workspace${session ? " has-session" : ""}`}>
          <header className="workspace-header">
            <button
              type="button"
              className="icon-button sidebar-toggle"
              aria-label="Open sessions"
              onClick={() => setSidebarOpen(true)}
            >
              <Icon name="menu" />
            </button>
            {session ? (
              <>
                <button
                  type="button"
                  className="mobile-back"
                  onClick={() => store.selectSession(null)}
                >
                  <Icon name="back" /> Sessions
                </button>
                <div className="workspace-title">
                  <div>
                    <h1>{session.name}</h1>
                    <span>
                      {session.agentLabel} · {session.repo ?? session.cwd}
                    </span>
                  </div>
                  <span className={`session-status is-${session.turnState}`}>
                    <i />
                    {turnLabel(session.turnState)}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Session details"
                  onClick={() => setFactsOpen(true)}
                >
                  <Icon name="info" />
                </button>
              </>
            ) : (
              <div className="workspace-title">
                <div>
                  <h1>Sessions</h1>
                  <span>Local ACP agent work</span>
                </div>
              </div>
            )}
          </header>
          {session ? (
            <AcpxRuntimeProvider>
              <Transcript />
            </AcpxRuntimeProvider>
          ) : (
            <Welcome onCreate={() => setDialog("create")} onAdopt={() => setDialog("adopt")} />
          )}
        </section>
        <SessionFacts open={factsOpen} onClose={() => setFactsOpen(false)} />
      </div>
      <SessionDialog mode={dialog} onClose={() => setDialog(null)} />
      <div className="notice-stack" aria-live="polite">
        {store.notices.map((notice) => (
          <button
            type="button"
            key={notice.id}
            className={`notice is-${notice.tone}`}
            onClick={() => store.dismissNotice(notice.id)}
          >
            {notice.message}
            <Icon name="close" size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}
