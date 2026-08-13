import { api, type ConsoleApi } from "./api";
import type { AgentSummary } from "./types";

interface WireAgent {
  readonly agentId: string;
  readonly label: string;
  readonly supportsSessionList?: boolean;
}

interface WireAgentInventory {
  readonly agents: readonly WireAgent[];
}

type JsonReader = Pick<ConsoleApi, "get">;

export async function loadWorkspaceAgents(
  cwd: string,
  client: JsonReader = api,
): Promise<readonly AgentSummary[]> {
  const search = new URLSearchParams({ cwd });
  const inventory = await client.get<WireAgentInventory>(`/api/v1/agents?${search}`);
  return inventory.agents.map((agent) => ({
    id: agent.agentId,
    label: agent.label,
    canBrowseSessions: agent.supportsSessionList,
  }));
}
