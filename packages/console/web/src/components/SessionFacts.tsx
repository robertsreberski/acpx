import { useSessionStore } from "../session-store";
import { Icon } from "./Icon";

const Fact = ({ label, value }: { readonly label: string; readonly value?: string | number }) =>
  value === undefined ? null : (
    <div className="fact-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );

export function SessionFacts({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const { selectedSession: session, closeSession, actionBusy } = useSessionStore();
  if (!session) {
    return null;
  }
  return (
    <aside
      className={`facts-drawer${open ? " is-open" : ""}`}
      aria-label="Session details"
      aria-hidden={!open}
    >
      <header>
        <div>
          <span>Session details</span>
          <strong>{session.name}</strong>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close session details"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <dl>
        <Fact label="Agent" value={session.agentLabel} />
        <Fact label="Workspace" value={session.cwd} />
        <Fact label="Branch" value={session.branch} />
        <Fact label="Mode" value={session.mode} />
        <Fact label="Model" value={session.model} />
        <Fact label="Session" value={session.sessionState} />
        <Fact label="Owner" value={session.ownerState} />
        <Fact label="Turn" value={session.turnState.replaceAll("_", " ")} />
        <Fact label="Queued" value={session.queuedCount} />
        <Fact label="Pending" value={session.pendingCount} />
        <Fact label="ACPX record" value={session.id} />
        <Fact label="Provider session" value={session.providerSessionId} />
      </dl>
      {session.permissionPolicy !== undefined && (
        <details className="raw-disclosure">
          <summary>Permission policy</summary>
          <pre>{JSON.stringify(session.permissionPolicy, null, 2)}</pre>
        </details>
      )}
      {session.sessionState === "open" && (
        <button
          type="button"
          className="danger-button"
          disabled={actionBusy}
          onClick={() => {
            if (window.confirm("Close this ACPX session? Pending requests will be removed.")) {
              void closeSession();
            }
          }}
        >
          <Icon name="archive" size={16} /> Close session
        </button>
      )}
    </aside>
  );
}
