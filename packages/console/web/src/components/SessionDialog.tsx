import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useDismissibleLayer } from "../dismissible-layer";
import { useSessionStore } from "../session-store";
import type { AgentSummary, ProviderSession } from "../types";
import { Icon } from "./Icon";

interface DialogProps {
  readonly mode: "create" | "adopt" | null;
  readonly onClose: () => void;
}

const firstAgent = (agents: readonly AgentSummary[]): string => agents[0]?.id ?? "";

export function SessionDialog({ mode, onClose }: DialogProps) {
  const store = useSessionStore();
  const [agentId, setAgentId] = useState("");
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [sessionMode, setSessionMode] = useState("");
  const [model, setModel] = useState("");
  const [providerSessionId, setProviderSessionId] = useState("");
  const [providerSessions, setProviderSessions] = useState<readonly ProviderSession[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useDismissibleLayer(mode !== null, onClose, dialogRef);

  const agent = store.bootstrap.agents.find((item) => item.id === agentId);

  useEffect(() => {
    if (!mode) {
      return;
    }
    setAgentId(firstAgent(store.bootstrap.agents));
    setCwd(store.bootstrap.workspaceRoots[0]?.path ?? "");
    setName("");
    setSessionMode("");
    setModel("");
    setProviderSessionId("");
    setProviderSessions([]);
    setError(null);
  }, [mode, store.bootstrap.agents, store.bootstrap.workspaceRoots]);

  useEffect(() => {
    if (mode !== "adopt" || !agentId || agent?.canBrowseSessions === false) {
      return;
    }
    let cancelled = false;
    setLoadingProviders(true);
    if (!cwd) {
      return;
    }
    void api
      .providerSessions(agentId, cwd)
      .then(
        (page) => {
          if (!cancelled) {
            setProviderSessions(page.sessions);
          }
        },
        () => {
          if (!cancelled) {
            setProviderSessions([]);
          }
        },
      )
      .finally(() => {
        if (!cancelled) {
          setLoadingProviders(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agent?.canBrowseSessions, agentId, cwd, mode]);

  if (!mode) {
    return null;
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const action =
      mode === "create"
        ? store.createSession({
            agentId,
            cwd,
            name: name.trim() || undefined,
            mode: sessionMode || undefined,
            model: model || undefined,
            permissionPolicy: "defer-risky",
          })
        : store.adoptSession({
            agentId,
            cwd,
            providerSessionId: providerSessionId.trim(),
            name: name.trim() || undefined,
          });
    void action.then(onClose, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "The session could not be saved.");
    });
  };

  return (
    <div
      className="dialog-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        ref={dialogRef}
        className="session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-dialog-title"
      >
        <header>
          <div>
            <span>{mode === "create" ? "Start fresh" : "Continue existing work"}</span>
            <h2 id="session-dialog-title">{mode === "create" ? "New session" : "Adopt session"}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <form onSubmit={submit}>
          <label className="form-field">
            <span>Agent</span>
            <select value={agentId} onChange={(event) => setAgentId(event.target.value)} required>
              {store.bootstrap.agents.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>Workspace</span>
            <select value={cwd} onChange={(event) => setCwd(event.target.value)} required>
              {store.bootstrap.workspaceRoots.map((root) => (
                <option value={root.path} key={root.id}>
                  {root.label} — {root.path}
                </option>
              ))}
            </select>
            <small>Only administrator-allowlisted workspace roots are available.</small>
          </label>
          <label className="form-field">
            <span>
              Name <em>optional</em>
            </span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Fix checkout regression"
            />
          </label>
          {mode === "create" && (
            <>
              {(agent?.modes?.length || agent?.models?.length) && (
                <div className="form-columns">
                  {agent.modes?.length && (
                    <label className="form-field">
                      <span>Mode</span>
                      <select
                        value={sessionMode}
                        onChange={(event) => setSessionMode(event.target.value)}
                      >
                        <option value="">Safe agent default</option>
                        {agent.modes.map((item) => (
                          <option value={item.id} key={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {agent.models?.length && (
                    <label className="form-field">
                      <span>Model</span>
                      <select value={model} onChange={(event) => setModel(event.target.value)}>
                        <option value="">Agent default</option>
                        {agent.models.map((item) => (
                          <option value={item.id} key={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              )}
              <div className="policy-callout">
                <strong>Review risky operations</strong>
                <p>
                  Read and search operations proceed. Writes, execution, and mode changes wait for
                  your approval.
                </p>
              </div>
            </>
          )}
          {mode === "adopt" && (
            <label className="form-field">
              <span>Provider session</span>
              {loadingProviders && <small>Looking for sessions…</small>}
              {providerSessions.length > 0 && (
                <select
                  value={providerSessionId}
                  onChange={(event) => setProviderSessionId(event.target.value)}
                >
                  <option value="">Enter an ID manually</option>
                  {providerSessions.map((session) => (
                    <option key={session.id} value={session.id} disabled={session.alreadyAdopted}>
                      {session.label}
                      {session.alreadyAdopted ? " — already adopted" : ""}
                    </option>
                  ))}
                </select>
              )}
              <input
                value={providerSessionId}
                onChange={(event) => setProviderSessionId(event.target.value)}
                placeholder="Provider session ID"
                required
              />
              <small>
                ACPX will load or resume this exact session. It will never substitute a new one.
              </small>
            </label>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <footer>
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={
                store.actionBusy || !agentId || !cwd || (mode === "adopt" && !providerSessionId)
              }
            >
              {mode === "create" ? "Create session" : "Adopt session"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
