import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ConsoleSession } from "../src/contracts.js";
import { startAcpxConsoleServer } from "../src/server.js";
import { MockSessionService, session as baseSession } from "./helpers.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-scope-"));
  const workspaceRoot = join(root, "allowed");
  const project = join(workspaceRoot, "project");
  const outside = join(root, "outside");
  const web = join(root, "web");
  const projectAlias = join(workspaceRoot, "project-alias");
  const escape = join(workspaceRoot, "escape");
  await Promise.all([mkdir(project, { recursive: true }), mkdir(outside), mkdir(web)]);
  await Promise.all([
    symlink(project, projectAlias, "dir"),
    symlink(outside, escape, "dir"),
    writeFile(join(web, "index.html"), "ok"),
  ]);
  const canonicalProject = await realpath(project);
  const configuredWorkspaceRoots = [workspaceRoot];
  const configuredAllowedHosts = ["127.0.0.1"];
  const service = new MockSessionService(project);
  const outsideSession: ConsoleSession = {
    ...baseSession,
    acpxRecordId: "outside-record",
    cwd: outside,
  };
  const escapedSession: ConsoleSession = {
    ...baseSession,
    acpxRecordId: "escaped-record",
    cwd: escape,
  };
  service.sessions.push(outsideSession, escapedSession);
  const running = await startAcpxConsoleServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      trustNetwork: false,
      allowedHosts: configuredAllowedHosts,
      workspaceRoots: configuredWorkspaceRoots,
      stateDir: join(root, "state"),
      staticDir: web,
    },
    service,
    logger: { info() {}, warn() {}, error() {} },
  });
  return {
    escape,
    configuredWorkspaceRoots,
    configuredAllowedHosts,
    outside,
    project: canonicalProject,
    projectAlias,
    running,
    service,
    workspaceRoot,
  };
}

async function auth(origin: string) {
  const response = await fetch(`${origin}/api/v1/bootstrap`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    csrfToken: string;
    sessions: Array<{ acpxRecordId: string }>;
  };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return { cookie, csrfToken: body.csrfToken, sessions: body.sessions };
}

function mutationHeaders(credentials: { cookie: string; csrfToken: string }, key: string) {
  return {
    "Content-Type": "application/json",
    Cookie: credentials.cookie,
    "X-CSRF-Token": credentials.csrfToken,
    "Idempotency-Key": key,
  };
}

async function getWithHost(origin: string, host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const target = new URL(origin);
    const outgoing = request(
      {
        host: target.hostname,
        port: Number(target.port),
        path: "/healthz",
        headers: { Host: host },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

test("configured roots scope session inventories and every retained-session operation", async () => {
  const { running, service } = await fixture();
  const invoked: string[] = [];
  service.getTranscriptPage = async () => {
    invoked.push("timeline");
    return { epoch: null, items: [], hasMore: false, coverage: "complete" };
  };
  service.listPendingRequests = async () => {
    invoked.push("pending");
    return [];
  };
  service.respondToPendingRequest = async (input) => {
    invoked.push("answer");
    return {
      requestId: input.requestId,
      acpxRecordId: input.acpxRecordId,
      kind: "permission",
      state: "answered",
      createdAt: "2026-08-13T00:00:00.000Z",
    };
  };
  service.enqueuePrompt = async () => {
    invoked.push("prompt");
    return { turnId: "turn", admission: "started" };
  };
  service.cancelTurn = async (input) => {
    invoked.push("cancel");
    return { turnId: input.turnId, state: "cancelling" };
  };
  service.closeSession = async () => {
    invoked.push("close");
    return {
      session: { ...service.sessions[0], sessionState: "closed" },
      localClose: "closed",
      providerClose: { status: "confirmed" },
    };
  };

  try {
    const credentials = await auth(running.origin);
    assert.deepEqual(
      credentials.sessions.map((session) => session.acpxRecordId),
      ["record-1"],
    );
    const inventory = await fetch(`${running.origin}/api/v1/sessions`);
    assert.deepEqual(
      ((await inventory.json()) as { sessions: Array<{ acpxRecordId: string }> }).sessions.map(
        (session) => session.acpxRecordId,
      ),
      ["record-1"],
    );

    const reads = [
      "/api/v1/sessions/outside-record",
      "/api/v1/sessions/outside-record/timeline",
      "/api/v1/sessions/outside-record/pending",
      "/api/v1/sessions/escaped-record",
    ];
    for (const path of reads) {
      const response = await fetch(`${running.origin}${path}`);
      assert.equal(response.status, 404, path);
      assert.deepEqual(await response.json(), {
        error: { code: "SESSION_NOT_FOUND", message: "Session not found" },
      });
    }

    const mutations = [
      {
        path: "/api/v1/sessions/outside-record/turns",
        body: { text: "do not send" },
      },
      {
        path: "/api/v1/sessions/outside-record/turns/turn-1/cancel",
        body: {},
      },
      {
        path: "/api/v1/sessions/outside-record/pending/request-1/responses",
        body: { response: { type: "decline" } },
      },
      { path: "/api/v1/sessions/outside-record/close", body: {} },
    ];
    for (const [index, mutation] of mutations.entries()) {
      const response = await fetch(`${running.origin}${mutation.path}`, {
        method: "POST",
        headers: mutationHeaders(credentials, `outside-${index}-key`),
        body: JSON.stringify(mutation.body),
      });
      assert.equal(response.status, 404, mutation.path);
    }
    assert.deepEqual(invoked, []);
  } finally {
    await running.close();
  }
});

test("server startup canonicalizes a configured symlink root exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-scope-root-alias-"));
  const workspaceRoot = join(root, "allowed");
  const workspaceAlias = join(root, "allowed-alias");
  const project = join(workspaceRoot, "project");
  const outside = join(root, "outside");
  const web = join(root, "web");
  await Promise.all([mkdir(project, { recursive: true }), mkdir(outside), mkdir(web)]);
  await writeFile(join(web, "index.html"), "ok");
  await symlink(workspaceRoot, workspaceAlias, "dir");
  const service = new MockSessionService(project);
  const running = await startAcpxConsoleServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      trustNetwork: false,
      allowedHosts: ["127.0.0.1"],
      workspaceRoots: [workspaceAlias],
      stateDir: join(root, "state"),
      staticDir: web,
    },
    service,
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    const credentials = await auth(running.origin);
    assert.deepEqual(
      credentials.sessions.map((session) => session.acpxRecordId),
      ["record-1"],
    );

    await rm(workspaceAlias);
    await symlink(outside, workspaceAlias, "dir");
    const detail = await fetch(`${running.origin}/api/v1/sessions/record-1`);
    assert.equal(detail.status, 200);
  } finally {
    await running.close();
  }
});

test("server startup owns its workspace-root snapshot", async () => {
  const { configuredAllowedHosts, configuredWorkspaceRoots, outside, running } = await fixture();

  try {
    configuredWorkspaceRoots.splice(0, configuredWorkspaceRoots.length, outside);
    configuredAllowedHosts.splice(0, configuredAllowedHosts.length, "evil.example.test");
    const credentials = await auth(running.origin);
    assert.deepEqual(
      credentials.sessions.map((session) => session.acpxRecordId),
      ["record-1"],
    );
    const outsideDetail = await fetch(`${running.origin}/api/v1/sessions/outside-record`);
    assert.equal(outsideDetail.status, 404);
    assert.equal(await getWithHost(running.origin, "evil.example.test"), 403);
  } finally {
    await running.close();
  }
});

test("a retained session stays visible and controllable after its workspace leaf disappears", async () => {
  const { escape, project, running, service, workspaceRoot } = await fixture();
  service.sessions.push({
    ...baseSession,
    acpxRecordId: "missing-symlink-record",
    cwd: join(workspaceRoot, "escape", "missing"),
  });

  try {
    const credentials = await auth(running.origin);
    await Promise.all([rm(project, { recursive: true }), rm(escape)]);

    const inventory = await fetch(`${running.origin}/api/v1/sessions`);
    assert.equal(inventory.status, 200);
    assert.deepEqual(
      ((await inventory.json()) as { sessions: Array<{ acpxRecordId: string }> }).sessions.map(
        (session) => session.acpxRecordId,
      ),
      ["record-1"],
    );

    const detail = await fetch(`${running.origin}/api/v1/sessions/record-1`);
    assert.equal(detail.status, 200);
    assert.equal(
      ((await detail.json()) as { session: ConsoleSession }).session.cwd,
      service.sessions[0]?.cwd,
    );

    const cancel = await fetch(`${running.origin}/api/v1/sessions/record-1/turns/turn-1/cancel`, {
      method: "POST",
      headers: mutationHeaders(credentials, "missing-workspace-cancel"),
      body: "{}",
    });
    assert.equal(cancel.status, 202);

    const close = await fetch(`${running.origin}/api/v1/sessions/record-1/close`, {
      method: "POST",
      headers: mutationHeaders(credentials, "missing-workspace-close"),
      body: "{}",
    });
    assert.equal(close.status, 200);
    assert.deepEqual(
      service.calls.map((call) => call.method),
      ["cancelTurn", "closeSession"],
    );

    const escaped = await fetch(`${running.origin}/api/v1/sessions/missing-symlink-record`);
    assert.equal(escaped.status, 404);
  } finally {
    await running.close();
  }
});

test("replacing a configured root cannot redefine its startup authorization boundary", async () => {
  const { outside, running, service, workspaceRoot } = await fixture();

  try {
    const credentials = await auth(running.origin);
    service.calls.length = 0;
    await rm(workspaceRoot, { recursive: true });
    await mkdir(join(outside, "project"));
    await symlink(outside, workspaceRoot, "dir");

    const detail = await fetch(`${running.origin}/api/v1/sessions/record-1`);
    assert.equal(detail.status, 404);
    assert.deepEqual(await detail.json(), {
      error: { code: "SESSION_NOT_FOUND", message: "Session not found" },
    });

    const close = await fetch(`${running.origin}/api/v1/sessions/record-1/close`, {
      method: "POST",
      headers: mutationHeaders(credentials, "replaced-root-close"),
      body: "{}",
    });
    assert.equal(close.status, 404);
    assert.deepEqual(service.calls, []);
  } finally {
    await running.close();
  }
});

test("agent and provider inventories require and retain one canonical workspace scope", async () => {
  const { escape, outside, project, projectAlias, running, service } = await fixture();
  const agentCwds: string[] = [];
  service.listAgents = async ({ cwd }) => {
    agentCwds.push(cwd);
    return [{ agentId: cwd === project ? "project-agent" : "unexpected", label: "Project agent" }];
  };
  service.listProviderSessions = async ({ cwd }) => ({
    sessions: [
      { providerSessionId: "allowed", cwd },
      { providerSessionId: "outside", cwd: outside },
      { providerSessionId: "escaped", cwd: escape },
      { providerSessionId: "unscoped" },
    ],
  });

  try {
    await auth(running.origin);
    agentCwds.length = 0;
    const agents = await fetch(
      `${running.origin}/api/v1/agents?cwd=${encodeURIComponent(projectAlias)}`,
    );
    assert.equal(agents.status, 200);
    assert.deepEqual(await agents.json(), {
      agents: [{ agentId: "project-agent", label: "Project agent" }],
    });
    assert.deepEqual(agentCwds, [project]);

    for (const path of ["/api/v1/agents", "/api/v1/agents/codex/sessions"]) {
      const response = await fetch(`${running.origin}${path}`);
      assert.equal(response.status, 400, path);
    }

    // A directory outside the configured roots is still refused, but now as an
    // unauthorized workspace rather than malformed input, so the console can
    // offer to authorize it instead of presenting a dead validation error.
    for (const path of [
      `/api/v1/agents?cwd=${encodeURIComponent(escape)}`,
      `/api/v1/agents/codex/sessions?cwd=${encodeURIComponent(escape)}`,
    ]) {
      const response = await fetch(`${running.origin}${path}`);
      assert.equal(response.status, 403, path);
      assert.equal((await response.json()).error.code, "WORKSPACE_NOT_AUTHORIZED", path);
    }

    const provider = await fetch(
      `${running.origin}/api/v1/agents/codex/sessions?cwd=${encodeURIComponent(projectAlias)}`,
    );
    assert.equal(provider.status, 200);
    assert.deepEqual(await provider.json(), {
      sessions: [{ providerSessionId: "allowed", cwd: project }],
    });
  } finally {
    await running.close();
  }
});

test("withheld sessions are reported by workspace, and only a real directory is offered for authorization", async () => {
  const { running, service, outside, workspaceRoot } = await fixture();
  try {
    // A workspace that existed when the session ran and has since been deleted:
    // no grant can ever resolve it, so it must not be offered as authorizable.
    const deleted = join(workspaceRoot, "..", "deleted-worktree");
    await mkdir(deleted, { recursive: true });
    service.sessions.push({ ...baseSession, acpxRecordId: "deleted-record", cwd: deleted });
    await rm(deleted, { recursive: true, force: true });

    const response = await fetch(`${running.origin}/api/v1/sessions`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      sessions: Array<{ acpxRecordId: string }>;
      hiddenWorkspaces: Array<{ path: string; sessionCount: number; reason: string }>;
    };

    // The admission rule is unchanged: only the in-root session is served.
    assert.deepEqual(
      body.sessions.map((entry) => entry.acpxRecordId),
      [baseSession.acpxRecordId],
    );

    const canonicalOutside = await realpath(outside);
    const unauthorized = body.hiddenWorkspaces.find((entry) => entry.path === canonicalOutside);
    // Both the direct path and the symlink that escapes into it canonicalize to
    // one directory, so the operator is asked to authorize it once, not twice.
    assert.deepEqual(unauthorized, {
      path: canonicalOutside,
      sessionCount: 2,
      reason: "unauthorized",
    });

    const missing = body.hiddenWorkspaces.find((entry) => entry.reason === "missing");
    assert.equal(missing?.sessionCount, 1);
    assert.match(missing?.path ?? "", /deleted-worktree$/);

    // Nothing about the withheld sessions themselves crosses the boundary — only
    // the directory the operator would act on.
    assert.equal(JSON.stringify(body.hiddenWorkspaces).includes(baseSession.acpxRecordId), false);
  } finally {
    await running.close();
  }
});
