import type { SessionSummary } from "./types";

/**
 * Presentation helpers for the session list and workspace header.
 *
 * The design treats mode as a first-class label — "the difference between a
 * session that can only propose and one that can write" — so the badge carries
 * the real adapter mode id and lets colour, not a renamed label, express that
 * distinction. Inventing "Plan"/"Execute" labels would hide which mode is
 * actually in force.
 */

/** Modes that cannot modify the workspace. Everything else is treated as write-capable. */
const PROPOSE_ONLY_MODES = new Set([
  "plan",
  "planning",
  "read-only",
  "readonly",
  "read_only",
  "ask",
  "chat",
  "review",
]);

export const displayRepo = (session: SessionSummary): string =>
  session.repo ?? session.cwd.split("/").findLast(Boolean) ?? session.cwd;

/**
 * The adapter's most recent report of the session mode, falling back to what was
 * requested. This is the best evidence the session list has — it is not proof
 * the mode is in force, which only `SessionDetail.modeState` can speak to, and
 * session details shows that separately.
 */
export const sessionMode = (session: SessionSummary): string | undefined =>
  session.effectiveMode ?? session.mode ?? session.desiredMode;

export const humanizeModeId = (mode: string): string => {
  const spaced = mode
    .replaceAll(/[_-]+/g, " ")
    .replaceAll(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim()
    .toLocaleLowerCase();
  return spaced ? spaced[0].toLocaleUpperCase() + spaced.slice(1) : mode;
};

export interface ModeBadge {
  readonly label: string;
  readonly canWrite: boolean;
}

export const modeBadge = (session: SessionSummary): ModeBadge | undefined => {
  const mode = sessionMode(session)?.trim();
  if (!mode) {
    return undefined;
  }
  return {
    label: humanizeModeId(mode),
    canWrite: !PROPOSE_ONLY_MODES.has(mode.toLocaleLowerCase()),
  };
};

/** `agent · model`. Effort is not carried by the sessions contract, so it is omitted. */
export const harnessLine = (session: SessionSummary): string =>
  [session.agentLabel, session.model]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");

const ACTIVE_TURN_LABELS: Readonly<Record<string, string>> = {
  running: "Running",
  starting: "Starting",
  queued: "Queued",
  cancelling: "Cancelling",
};

export type SessionTone = "needs" | "working" | "idle";

export interface SessionStatus {
  readonly text: string;
  readonly tone: SessionTone;
}

export const sessionStatus = (session: SessionSummary): SessionStatus => {
  const queued = session.queuedCount > 0 ? ` · ${session.queuedCount} queued` : "";
  if (
    session.pendingCount > 0 ||
    session.turnState === "waiting_permission" ||
    session.turnState === "waiting_elicitation"
  ) {
    return { text: `Needs you${queued}`, tone: "needs" };
  }
  const active = ACTIVE_TURN_LABELS[session.turnState];
  if (active) {
    return { text: `${active}${queued}`, tone: "working" };
  }
  return { text: `${humanizeModeId(session.turnState)}${queued}`, tone: "idle" };
};

/**
 * Repo-grouped sessions, projects ordered alphabetically and rows within a
 * project by recency. The order deliberately ignores turn state: sorting by
 * urgency would make a project jump the moment a turn ended, and the design
 * asks for the opposite — "nothing jumps groups when a turn ends".
 */
export const groupSessionsByRepo = (
  sessions: readonly SessionSummary[],
): readonly { readonly repo: string; readonly sessions: readonly SessionSummary[] }[] => {
  const groups = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const repo = displayRepo(session);
    const existing = groups.get(repo);
    if (existing) {
      existing.push(session);
    } else {
      groups.set(repo, [session]);
    }
  }
  return [...groups.entries()]
    .map(([repo, entries]) => ({
      repo,
      sessions: entries.toSorted((left, right) =>
        right.lastActivityAt.localeCompare(left.lastActivityAt),
      ),
    }))
    .toSorted((left, right) => left.repo.localeCompare(right.repo));
};
