import type { AgentSummary } from "./types";

const SAFE_DEFAULT_AGENTS = new Set(["codex", "claude"]);

export type ModeControlType = "none" | "select" | "input";

export function requiresExplicitMode(agent: AgentSummary | undefined): boolean {
  return agent !== undefined && !SAFE_DEFAULT_AGENTS.has(agent.id);
}

export function modeControlType(agent: AgentSummary | undefined): ModeControlType {
  if (!agent) {
    return "none";
  }
  if (agent.modes?.length) {
    return "select";
  }
  return requiresExplicitMode(agent) ? "input" : "none";
}

export function normalizeSessionMode(value: string): string | undefined {
  return value.trim() || undefined;
}
