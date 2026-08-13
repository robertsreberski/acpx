import type { AgentSummary } from "./types";

const SAFE_DEFAULT_MODES: Readonly<Record<string, string>> = {
  codex: "read-only",
  claude: "default",
};

export function safeDefaultMode(agent: AgentSummary | undefined): string | undefined {
  return agent ? SAFE_DEFAULT_MODES[agent.id] : undefined;
}

export function requiresExplicitMode(agent: AgentSummary | undefined): boolean {
  return agent !== undefined && safeDefaultMode(agent) === undefined;
}

export function normalizeExactId(value: string): string | undefined {
  return value.trim() || undefined;
}
