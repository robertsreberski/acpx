import assert from "node:assert/strict";
import test from "node:test";
import { loadWorkspaceAgents } from "../src/workspace-agent-inventory";

test("workspace agent inventory encodes the exact cwd and projects browser-safe fields", async () => {
  const paths: string[] = [];
  const agents = await loadWorkspaceAgents("/work/project one", {
    async get<T>(path: string): Promise<T> {
      paths.push(path);
      return {
        agents: [
          {
            agentId: "project-agent",
            label: "Project agent",
            supportsSessionList: true,
            command: "must-not-cross-the-boundary",
          },
        ],
      } as T;
    },
  });

  assert.deepEqual(paths, ["/api/v1/agents?cwd=%2Fwork%2Fproject+one"]);
  assert.deepEqual(agents, [
    { id: "project-agent", label: "Project agent", canBrowseSessions: true },
  ]);
});

test("workspace agent inventory preserves an empty project registry", async () => {
  assert.deepEqual(
    await loadWorkspaceAgents("/work/empty", {
      async get<T>(): Promise<T> {
        return { agents: [] } as T;
      },
    }),
    [],
  );
});
