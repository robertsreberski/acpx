import type { ProbeCatalog, ProbeOption } from "./types";

/**
 * What to preselect once an agent has told us what it supports.
 *
 * The agent's own advertised default is deliberately NOT inherited for mode.
 * Codex advertises its write-capable `agent` mode as current, while the console
 * pins Codex to `read-only`; adopting the advertised default would silently
 * upgrade a new session from proposing to writing. So the console's safe
 * default wins when the agent offers it, and otherwise nothing is preselected
 * and the operator has to choose.
 *
 * Model carries no such hazard — one model is not more dangerous than another —
 * so the advertised current model is a fine starting point.
 */

export const catalogOptions = (catalog: ProbeCatalog | undefined): readonly ProbeOption[] =>
  catalog?.advertised ? catalog.options : [];

export const catalogHasValue = (catalog: ProbeCatalog | undefined, value: string): boolean =>
  catalogOptions(catalog).some((option) => option.value === value);

/**
 * The mode to preselect: the console's safe default when the agent advertises
 * it, otherwise none. Never the agent's advertised current mode.
 */
export const preselectedMode = (
  catalog: ProbeCatalog | undefined,
  safeDefault: string | undefined,
): string => (safeDefault && catalogHasValue(catalog, safeDefault) ? safeDefault : "");

/** The model to preselect: whatever the agent says it is already using. */
export const preselectedModel = (catalog: ProbeCatalog | undefined): string =>
  catalog?.advertised && catalog.currentValue && catalogHasValue(catalog, catalog.currentValue)
    ? catalog.currentValue
    : "";

const FAILURE_REASONS: Readonly<Record<string, string>> = {
  auth_required: "the agent needs to be signed in",
  timeout: "the agent did not answer in time",
  spawn_failed: "the agent could not be started",
  protocol_error: "the agent returned an unexpected reply",
};

/**
 * What to tell the operator when discovery did not produce a list. Every case
 * still leaves the field usable, so the wording says what to do rather than
 * reporting a failure they cannot act on.
 */
export const probeHint = (
  probe: { readonly status: string; readonly code?: string } | undefined,
  loading: boolean,
): string | undefined => {
  if (loading) {
    return "Asking the agent what it supports…";
  }
  if (!probe) {
    return undefined;
  }
  if (probe.status === "unsupported") {
    return "This ACPX build cannot list options. Enter an exact ID.";
  }
  if (probe.status === "failed") {
    const reason = probe.code ? FAILURE_REASONS[probe.code] : undefined;
    return `Options could not be listed${reason ? ` — ${reason}` : ""}. Enter an exact ID.`;
  }
  return undefined;
};
