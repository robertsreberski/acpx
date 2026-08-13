import type { AgentSummary, WorkspaceRoot } from "./types";

export interface ReconciledDialogOptions {
  readonly agentId: string;
  readonly cwd: string;
  readonly agentChanged: boolean;
  readonly workspaceChanged: boolean;
}

export function reconcileDialogOptions(
  currentAgentId: string,
  currentCwd: string,
  agents: readonly AgentSummary[],
  workspaceRoots: readonly WorkspaceRoot[],
): ReconciledDialogOptions {
  const agentId = agents.some((agent) => agent.id === currentAgentId)
    ? currentAgentId
    : (agents[0]?.id ?? "");
  // A session may start in any directory the operator authorizes, so the
  // configured roots are only the opening suggestion. Snapping a typed path
  // back to a root — as this did when the workspace was a fixed dropdown —
  // would make every directory outside them unreachable.
  const cwd = currentCwd === "" ? (workspaceRoots[0]?.path ?? "") : currentCwd;
  return {
    agentId,
    cwd,
    agentChanged: agentId !== currentAgentId,
    workspaceChanged: cwd !== currentCwd,
  };
}
