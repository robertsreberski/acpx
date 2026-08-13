import { useEffect, useRef, useState } from "react";
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

/**
 * Identifiers exist to be pasted into a terminal, so they carry a copy control
 * rather than asking the reader to select 36 characters of monospace by hand.
 */
function CopyableFact({ label, value }: { readonly label: string; readonly value?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = window.setTimeout(() => setCopied(false), 1_600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  if (value === undefined || value === "") {
    return null;
  }
  const copy = () => {
    // `writeText` rejects without a secure context or clipboard permission; the
    // value stays selectable either way, so a failure just leaves the label be.
    void navigator.clipboard
      ?.writeText(value)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  return (
    <div className="fact-row is-copyable">
      <dt>{label}</dt>
      <dd>
        <span>{value}</span>
        <button type="button" className="copy-button" onClick={copy} aria-label={`Copy ${label}`}>
          <Icon name={copied ? "check" : "copy"} size={15} />
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
      </dd>
    </div>
  );
}

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
        <h2>Session id</h2>
        <dl>
          <CopyableFact label="ACPX record" value={session.id} />
          <CopyableFact label="Provider session" value={session.providerSessionId} />
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
          {session.activeTurnId !== undefined && (
            <details className="facts-disclosure">
              <summary>
                Active turn
                <Icon name="chevron" size={18} />
              </summary>
              <div>
                <dl>
                  <CopyableFact label="Turn id" value={session.activeTurnId} />
                </dl>
              </div>
            </details>
          )}
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
