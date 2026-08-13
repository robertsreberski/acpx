import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { DialogSubmission } from "../dialog-submission";
import { useDismissibleLayer } from "../dismissible-layer";
import { catalogOptions, preselectedMode, preselectedModel, probeHint } from "../probe-selection";
import { reconcileDialogOptions } from "../session-dialog-options";
import { normalizeExactId, requiresExplicitMode, safeDefaultMode } from "../session-mode";
import { useSessionStore } from "../session-store";
import type {
  AgentSummary,
  ProviderSession,
  SessionOptionsProbe,
  WorkspaceSuggestion,
} from "../types";
import { loadWorkspaceAgents } from "../workspace-agent-inventory";
import { Combobox } from "./Combobox";
import { Icon } from "./Icon";

interface DialogProps {
  readonly mode: "create" | "adopt" | null;
  readonly onClose: () => void;
}

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
  const [workspaceAgents, setWorkspaceAgents] = useState<readonly AgentSummary[]>([]);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [workspaceOptions, setWorkspaceOptions] = useState<readonly WorkspaceSuggestion[]>([]);
  const [needsAuthorization, setNeedsAuthorization] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [authorizedGeneration, setAuthorizedGeneration] = useState(0);
  const [probe, setProbe] = useState<SessionOptionsProbe | undefined>(undefined);
  const [probing, setProbing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const dialogModeRef = useRef<DialogProps["mode"]>(null);
  const agentGeneration = useRef(0);
  const providerGeneration = useRef(0);
  const submission = useRef(new DialogSubmission());
  const closeDialog = useCallback(() => {
    if (!submission.current.dismiss()) {
      return;
    }
    onClose();
  }, [onClose]);
  useDismissibleLayer(mode !== null, closeDialog, dialogRef);

  const agent = workspaceAgents.find((item) => item.id === agentId);
  const modeRequired = requiresExplicitMode(agent);
  const defaultMode = safeDefaultMode(agent);
  const normalizedMode = normalizeExactId(sessionMode);
  const normalizedModel = normalizeExactId(model);

  useEffect(() => {
    submission.current.replace();
    setSubmitting(false);
  }, [mode]);

  useEffect(() => {
    if (!mode) {
      dialogModeRef.current = null;
      return;
    }
    const opening = dialogModeRef.current !== mode;
    dialogModeRef.current = mode;
    const options = reconcileDialogOptions(
      opening ? "" : agentId,
      opening ? "" : cwd,
      workspaceAgents,
      store.bootstrap.workspaceRoots,
    );
    if (opening) {
      setAgentId(options.agentId);
      setCwd(options.cwd);
      setName("");
      setSessionMode("");
      setModel("");
      setProviderSessionId("");
      setProviderSessions([]);
      setProviderCursor(undefined);
      setProviderError(null);
      setWorkspaceAgents([]);
      setAgentError(null);
      setError(null);
      return;
    }
    if (options.agentChanged) {
      setAgentId(options.agentId);
      setSessionMode("");
      setModel("");
      setProviderSessionId("");
    }
    if (options.workspaceChanged) {
      setCwd(options.cwd);
      setAgentId("");
      setWorkspaceAgents([]);
      setAgentError(null);
      setProviderSessionId("");
    }
  }, [agentId, cwd, mode, store.bootstrap.workspaceRoots, workspaceAgents]);

  useEffect(() => {
    const generation = ++agentGeneration.current;
    if (!mode || !cwd) {
      setWorkspaceAgents([]);
      setAgentId("");
      setAgentError(null);
      setLoadingAgents(false);
      return undefined;
    }
    setLoadingAgents(true);
    setAgentError(null);
    setNeedsAuthorization(null);
    void loadWorkspaceAgents(cwd).then(
      (agents) => {
        if (generation !== agentGeneration.current) {
          return;
        }
        setWorkspaceAgents(agents);
        setAgentId(agents[0]?.id ?? "");
        setSessionMode("");
        setModel("");
        setProviderSessionId("");
        setLoadingAgents(false);
      },
      (reason: unknown) => {
        if (generation !== agentGeneration.current) {
          return;
        }
        setWorkspaceAgents([]);
        setAgentId("");
        // The agent inventory is the first call that touches the workspace, so
        // it is where an unauthorized directory surfaces. Offer to authorize it
        // rather than reporting it as a failure the operator cannot act on.
        if (reason instanceof ApiError && reason.code === "WORKSPACE_NOT_AUTHORIZED") {
          setNeedsAuthorization(cwd);
          setAgentError(null);
        } else {
          setAgentError(
            reason instanceof Error ? reason.message : "Workspace agents could not be loaded.",
          );
        }
        setLoadingAgents(false);
      },
    );
    return () => {
      if (generation === agentGeneration.current) {
        agentGeneration.current += 1;
      }
    };
  }, [cwd, mode, authorizedGeneration]);

  // Directory completions for whatever has been typed so far. Debounced so a
  // keystroke does not become a readdir, and generation-guarded so a slow reply
  // cannot overwrite the suggestions for a path the operator has moved past.
  useEffect(() => {
    if (!mode) {
      setWorkspaceOptions([]);
      return undefined;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void api.workspaceSuggestions(cwd).then(
        (suggestions) => {
          if (live) {
            setWorkspaceOptions(suggestions);
          }
        },
        () => {
          if (live) {
            setWorkspaceOptions([]);
          }
        },
      );
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [cwd, mode]);

  /*
   * Ask the selected agent what it supports. Discovery opens and discards a
   * provider session, so it is debounced, aborted when the selection moves on,
   * and never blocks session creation: a failure leaves both fields as free
   * text.
   */
  useEffect(() => {
    setProbe(undefined);
    if (!mode || !agentId || !cwd || loadingAgents) {
      setProbing(false);
      return undefined;
    }
    const controller = new AbortController();
    setProbing(true);
    const timer = window.setTimeout(() => {
      void api.probeSessionOptions(agentId, cwd, controller.signal).then(
        (result) => {
          if (controller.signal.aborted) {
            return;
          }
          setProbe(result);
          setProbing(false);
          if (result.status === "ready") {
            setSessionMode((current) =>
              current === "" ? preselectedMode(result.modes, defaultMode) : current,
            );
            setModel((current) => (current === "" ? preselectedModel(result.models) : current));
          }
        },
        () => {
          if (!controller.signal.aborted) {
            setProbe(undefined);
            setProbing(false);
          }
        },
      );
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [agentId, cwd, mode, loadingAgents, defaultMode]);

  const modeOptions = probe?.status === "ready" ? catalogOptions(probe.modes) : [];
  const modelOptions = probe?.status === "ready" ? catalogOptions(probe.models) : [];
  const modeHint = probeHint(probe, probing);

  const authorizeWorkspace = () => {
    if (!needsAuthorization) {
      return;
    }
    setAuthorizing(true);
    void api.authorizeWorkspace(needsAuthorization).then(
      (authorized) => {
        setAuthorizing(false);
        setNeedsAuthorization(null);
        setCwd(authorized);
        // Re-run the inventory now that the directory is reachable.
        setAuthorizedGeneration((value) => value + 1);
      },
      (reason: unknown) => {
        setAuthorizing(false);
        setAgentError(
          reason instanceof Error ? reason.message : "The workspace could not be authorized.",
        );
      },
    );
  };

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
    if (
      mode !== "adopt" ||
      loadingAgents ||
      !agentId ||
      !cwd ||
      agent?.canBrowseSessions === false
    ) {
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
  }, [agent?.canBrowseSessions, agentId, cwd, loadProviderSessions, loadingAgents, mode]);

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
    const generation = submission.current.begin();
    setSubmitting(true);
    const action =
      mode === "create"
        ? store.createSession({
            agentId,
            cwd,
            name: name.trim() || undefined,
            mode: normalizedMode,
            model: normalizedModel,
            permissionPolicy: "defer-risky",
          })
        : store.adoptSession({
            agentId,
            cwd,
            providerSessionId: providerSessionId.trim(),
            name: name.trim() || undefined,
            mode: normalizedMode,
          });
    void action.then(
      () => {
        if (!submission.current.complete(generation)) {
          return;
        }
        setSubmitting(false);
        onClose();
      },
      (reason: unknown) => {
        if (!submission.current.complete(generation)) {
          return;
        }
        setSubmitting(false);
        setError(reason instanceof Error ? reason.message : "The session could not be saved.");
      },
    );
  };

  return (
    <div
      className="dialog-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeDialog();
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
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={closeDialog}
            disabled={submitting}
          >
            <Icon name="close" />
          </button>
        </header>
        <form onSubmit={submit}>
          <label className="form-field">
            <span>Agent</span>
            {loadingAgents && <small>Loading agents for this workspace…</small>}
            {agentError && (
              <small className="form-error" role="alert">
                {agentError}
              </small>
            )}
            <select
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
                setSessionMode("");
                setModel("");
                setProviderSessionId("");
              }}
              disabled={loadingAgents || workspaceAgents.length === 0}
              required
            >
              {workspaceAgents.length === 0 && (
                <option value="">
                  {loadingAgents ? "Loading agents…" : "No agents registered"}
                </option>
              )}
              {workspaceAgents.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <div className="form-field">
            <span id="session-dialog-workspace">Workspace</span>
            <Combobox
              value={cwd}
              onChange={(next) => {
                setCwd(next);
                setAgentId("");
                setWorkspaceAgents([]);
                setAgentError(null);
                setSessionMode("");
                setModel("");
                setProviderSessionId("");
              }}
              options={workspaceOptions.map((suggestion) => ({
                value: suggestion.path,
                label: suggestion.label,
                hint: suggestion.authorized ? undefined : "needs authorizing",
              }))}
              placeholder="Type or pick any directory"
              required
            />
            {needsAuthorization ? (
              <div className="workspace-authorization" role="note">
                <p>
                  This directory is outside the configured workspace roots. Authorize it once to
                  start sessions here.
                </p>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={authorizeWorkspace}
                  disabled={authorizing}
                >
                  {authorizing ? "Authorizing…" : "Authorize this directory"}
                </button>
              </div>
            ) : (
              <small>
                Anything under {store.bootstrap.workspaceRoots.length === 1 ? "the root" : "a root"}{" "}
                is ready to use; anywhere else asks once.
              </small>
            )}
          </div>
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
          {mode === "create" ? (
            <div className="form-columns">
              <div className="form-field">
                <span id="session-dialog-create-mode">
                  Mode {!modeRequired && <em>optional</em>}
                </span>
                <Combobox
                  labelledBy="session-dialog-create-mode"
                  value={sessionMode}
                  onChange={setSessionMode}
                  options={modeOptions}
                  placeholder={defaultMode ? `Safe default: ${defaultMode}` : "Exact agent mode ID"}
                  loading={probing}
                  required={modeRequired}
                />
                <small>
                  {modeHint ??
                    (defaultMode
                      ? `Leave blank to use the safe ${defaultMode} default.`
                      : "Pick a mode, or enter an exact ID.")}
                </small>
              </div>
              <div className="form-field">
                <span id="session-dialog-model">
                  Model <em>optional</em>
                </span>
                <Combobox
                  labelledBy="session-dialog-model"
                  value={model}
                  onChange={setModel}
                  options={modelOptions}
                  placeholder="Exact agent model ID"
                  loading={probing}
                />
                <small>Leave blank to use the agent default.</small>
              </div>
            </div>
          ) : (
            <div className="form-field">
              <span id="session-dialog-mode">Mode {!modeRequired && <em>optional</em>}</span>
              <Combobox
                labelledBy="session-dialog-mode"
                value={sessionMode}
                onChange={setSessionMode}
                options={modeOptions}
                placeholder={defaultMode ? `Safe default: ${defaultMode}` : "Exact agent mode ID"}
                loading={probing}
                required={modeRequired}
              />
              <small>
                {modeHint ??
                  (defaultMode
                    ? `Leave blank to use the safe ${defaultMode} default.`
                    : "Pick a mode, or enter an exact ID.")}
              </small>
            </div>
          )}
          {mode === "create" && (
            <>
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
            <button
              type="button"
              className="secondary-button"
              onClick={closeDialog}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={
                submitting ||
                store.actionBusy ||
                loadingAgents ||
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
