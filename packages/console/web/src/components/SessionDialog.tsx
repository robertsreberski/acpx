import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useDismissibleLayer } from "../dismissible-layer";
import { modeControlType, normalizeSessionMode, requiresExplicitMode } from "../session-mode";
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
  const [providerCursor, setProviderCursor] = useState<string | undefined>(undefined);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const providerGeneration = useRef(0);
  useDismissibleLayer(mode !== null, onClose, dialogRef);

  const agent = store.bootstrap.agents.find((item) => item.id === agentId);
  const modeControl = modeControlType(agent);
  const modeRequired = requiresExplicitMode(agent);
  const normalizedMode = normalizeSessionMode(sessionMode);

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
    setProviderCursor(undefined);
    setProviderError(null);
    setError(null);
  }, [mode, store.bootstrap.agents, store.bootstrap.workspaceRoots]);

  const loadProviderSessions = useCallback(
    async (cursor?: string) => {
      const generation = providerGeneration.current;
      setLoadingProviders(true);
      setProviderError(null);
      try {
        const page = await api.providerSessions(agentId, cwd, cursor);
        if (generation !== providerGeneration.current) {
          return;
        }
        setProviderSessions((current) => {
          const source = cursor ? [...current, ...page.sessions] : [...page.sessions];
          return [...new Map(source.map((session) => [session.id, session])).values()];
        });
        setProviderCursor(page.nextCursor);
      } catch (reason) {
        if (generation !== providerGeneration.current) {
          return;
        }
        setProviderError(
          reason instanceof Error ? reason.message : "Provider sessions could not be loaded.",
        );
        if (!cursor) {
          setProviderSessions([]);
        }
      } finally {
        if (generation === providerGeneration.current) {
          setLoadingProviders(false);
        }
      }
    },
    [agentId, cwd],
  );

  useEffect(() => {
    if (mode !== "adopt" || !agentId || !cwd || agent?.canBrowseSessions === false) {
      providerGeneration.current += 1;
      setProviderSessions([]);
      setProviderCursor(undefined);
      setProviderError(null);
      setLoadingProviders(false);
      return undefined;
    }
    providerGeneration.current += 1;
    setProviderSessions([]);
    setProviderCursor(undefined);
    void loadProviderSessions();
    return () => {
      providerGeneration.current += 1;
    };
  }, [agent?.canBrowseSessions, agentId, cwd, loadProviderSessions, mode]);

  if (!mode) {
    return null;
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (modeRequired && !normalizedMode) {
      setError(`Enter a mode for ${agent?.label ?? agentId}.`);
      return;
    }
    const action =
      mode === "create"
        ? store.createSession({
            agentId,
            cwd,
            name: name.trim() || undefined,
            mode: normalizedMode,
            model: model || undefined,
            permissionPolicy: "defer-risky",
          })
        : store.adoptSession({
            agentId,
            cwd,
            providerSessionId: providerSessionId.trim(),
            name: name.trim() || undefined,
            mode: normalizedMode,
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
            <select
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
                setSessionMode("");
                setModel("");
                setProviderSessionId("");
              }}
              required
            >
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
          {modeControl === "input" && (
            <label className="form-field">
              <span>Mode</span>
              <input
                value={sessionMode}
                onChange={(event) => setSessionMode(event.target.value)}
                placeholder="Exact agent mode ID"
                autoComplete="off"
                required
              />
              <small>This agent has no advertised modes. ACPX will not guess one.</small>
            </label>
          )}
          {mode === "create" && (
            <>
              {(modeControl === "select" || agent?.models?.length) && (
                <div className="form-columns">
                  {modeControl === "select" && agent?.modes?.length && (
                    <label className="form-field">
                      <span>Mode</span>
                      <select
                        value={sessionMode}
                        onChange={(event) => setSessionMode(event.target.value)}
                        required={modeRequired}
                      >
                        <option value="">
                          {modeRequired ? "Choose a mode" : "Safe agent default"}
                        </option>
                        {agent.modes.map((item) => (
                          <option value={item.id} key={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {agent?.models?.length && (
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
          {mode === "adopt" && modeControl === "select" && agent?.modes?.length && (
            <label className="form-field">
              <span>Mode</span>
              <select
                value={sessionMode}
                onChange={(event) => setSessionMode(event.target.value)}
                required={modeRequired}
              >
                <option value="">{modeRequired ? "Choose a mode" : "Safe agent default"}</option>
                {agent.modes.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {mode === "adopt" && (
            <label className="form-field">
              <span>Provider session</span>
              {loadingProviders && <small>Looking for sessions…</small>}
              {providerError && (
                <small className="form-error" role="alert">
                  {providerError}
                </small>
              )}
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
              {providerCursor && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={loadingProviders}
                  onClick={() => void loadProviderSessions(providerCursor)}
                >
                  Load more provider sessions
                </button>
              )}
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
                store.actionBusy ||
                !agentId ||
                !cwd ||
                (modeRequired && !normalizedMode) ||
                (mode === "adopt" && !providerSessionId.trim())
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
