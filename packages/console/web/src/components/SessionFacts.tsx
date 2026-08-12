import { useRef } from "react";
import { useDismissibleLayer } from "../dismissible-layer";
import { useSessionStore } from "../session-store";
import { consumeUiAction } from "../ui-actions";
import { Icon } from "./Icon";

const Fact = ({ label, value }: { readonly label: string; readonly value?: string | number }) =>
  value === undefined ? null : (
    <div className="fact-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );

const modeStateLabel = {
  unmanaged: "No saved preference",
  stored: "Saved for the next owner",
  unverified: "Unverified on retained owner",
  conflict: "Conflict",
} as const;

export function SessionFacts({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const { selectedSession: session, closeSession, actionBusy } = useSessionStore();
  const drawerRef = useRef<HTMLElement>(null);
  useDismissibleLayer(open && session !== null, onClose, drawerRef);
  if (!session || !open) {
    return null;
  }
  return (
    <aside
      ref={drawerRef}
      className="facts-drawer is-open"
      role="dialog"
      aria-modal="true"
      aria-label="Session details"
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
        <Fact label="Desired mode" value={session.desiredMode} />
        <Fact label="Last adapter report" value={session.effectiveMode} />
        <Fact label="Mode assurance" value={modeStateLabel[session.modeState]} />
        <Fact label="Model" value={session.model} />
        <Fact label="Session" value={session.sessionState} />
        <Fact label="Owner" value={session.ownerState} />
        <Fact label="Turn" value={session.turnState.replaceAll("_", " ")} />
        <Fact label="Queued" value={session.queuedCount} />
        <Fact label="Pending" value={session.pendingCount} />
        <Fact label="ACPX record" value={session.id} />
        <Fact label="Provider session" value={session.providerSessionId} />
      </dl>
      {session.modeRemediation && (
        <div
          className={`mode-warning${session.modeState === "conflict" ? " is-error" : ""}`}
          role={session.modeState === "conflict" ? "alert" : "note"}
        >
          <strong>
            {session.modeState === "conflict"
              ? "Saved mode is not in force"
              : "Warm-owner mode is not verified"}
          </strong>
          <p>{session.modeRemediation}</p>
          <small>Stored preferences alone do not prove the retained adapter session's mode.</small>
        </div>
      )}
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
              consumeUiAction(closeSession());
            }
          }}
        >
          <Icon name="archive" size={16} /> Close session
        </button>
      )}
    </aside>
  );
}
