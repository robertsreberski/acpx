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
  const cwd = workspaceRoots.some((root) => root.path === currentCwd)
    ? currentCwd
    : (workspaceRoots[0]?.path ?? "");
  return {
    agentId,
    cwd,
    agentChanged: agentId !== currentAgentId,
    workspaceChanged: cwd !== currentCwd,
  };
}
