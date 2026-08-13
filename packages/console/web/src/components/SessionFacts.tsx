import { useRef } from "react";
import { useDismissibleLayer } from "../dismissible-layer";
import { displayRepo, humanizeModeId } from "../session-presentation";
import { useSessionStore } from "../session-store";
import { consumeUiAction } from "../ui-actions";
import { Icon } from "./Icon";

const Fact = ({ label, value }: { readonly label: string; readonly value?: string | number }) =>
  value === undefined || value === "" ? null : (
    <div className="fact-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );

const modeStateLabel = {
  unmanaged: "no saved preference",
  stored: "stored",
  unverified: "unverified",
  conflict: "conflict",
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
  const adapterMode = session.effectiveMode
    ? `${session.effectiveMode} · ${modeStateLabel[session.modeState]}`
    : modeStateLabel[session.modeState];
  const turn = [
    humanizeModeId(session.turnState).toLocaleLowerCase(),
    session.pendingCount > 0 ? `${session.pendingCount} pending` : undefined,
    session.queuedCount > 0 ? `${session.queuedCount} queued` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
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
          <Icon name="close" size={21} />
        </button>
      </header>
      <div className="facts-body">
        <h2>Harness</h2>
        <dl>
          <Fact label="Agent" value={session.agentLabel} />
          <Fact label="Model" value={session.model} />
          <Fact label="Desired mode" value={session.desiredMode ?? session.mode} />
          <Fact label="Adapter says" value={adapterMode} />
        </dl>
        <h2>Work</h2>
        <dl>
          <Fact label="Project" value={displayRepo(session)} />
          <Fact label="Workspace" value={session.cwd} />
          <Fact label="Branch" value={session.branch} />
          <Fact label="Turn" value={turn} />
          <Fact label="Owner" value={`${session.ownerState} · session ${session.sessionState}`} />
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
            <small>
              Stored preferences alone do not prove the retained adapter session's mode.
            </small>
          </div>
        )}
        <div className="facts-disclosures">
          <details className="facts-disclosure">
            <summary>
              Identifiers
              <Icon name="chevron" size={18} />
            </summary>
            <div>
              <dl>
                <Fact label="ACPX record" value={session.id} />
                <Fact label="Provider session" value={session.providerSessionId} />
                <Fact label="Active turn" value={session.activeTurnId} />
              </dl>
            </div>
          </details>
          {session.permissionPolicy !== undefined && (
            <details className="facts-disclosure">
              <summary>
                Permission policy
                <Icon name="chevron" size={18} />
              </summary>
              <div>
                <pre>{JSON.stringify(session.permissionPolicy, null, 2)}</pre>
              </div>
            </details>
          )}
        </div>
      </div>
      {session.sessionState === "open" && (
        <div className="facts-footer">
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
            <Icon name="archive" size={17} /> Close session
          </button>
        </div>
      )}
    </aside>
  );
}
