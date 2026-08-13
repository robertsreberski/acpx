import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResolvedConsoleConfig } from "../src/config.js";
import { startAcpxConsoleServer, type AcpxConsoleServerOptions } from "../src/server.js";
import { MockSessionService } from "./helpers.js";

async function fixture(
  serverOptions: Pick<AcpxConsoleServerOptions, "providerEnumerationLimit"> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-server-"));
  const web = join(root, "web");
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(web), mkdir(workspace)]);
  await writeFile(join(web, "index.html"), "<!doctype html><title>ACPX Console</title>");
  const config: ResolvedConsoleConfig = {
    host: "127.0.0.1",
    port: 0,
    trustNetwork: false,
    allowedHosts: ["127.0.0.1", "localhost"],
    workspaceRoots: [workspace],
    stateDir: join(root, "state"),
    staticDir: web,
  };
  const service = new MockSessionService(workspace);
  const running = await startAcpxConsoleServer({
    config,
    service,
    logger: { info() {}, warn() {}, error() {} },
    ...serverOptions,
  });
  return { root, workspace, service, running };
}

async function bootstrap(origin: string) {
  const response = await fetch(`${origin}/api/v1/bootstrap`);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const body = (await response.json()) as { csrfToken: string };
  assert.ok(cookie);
  return { cookie: cookie, csrfToken: body.csrfToken };
}

function mutationHeaders(auth: { cookie: string; csrfToken: string }, key = "request-12345") {
  return {
    "Content-Type": "application/json",
    Cookie: auth.cookie,
    "X-CSRF-Token": auth.csrfToken,
    "Idempotency-Key": key,
  };
}

async function requestWithHost(
  origin: string,
  host: string,
): Promise<{ status: number; body: string }> {
  const url = new URL(origin);
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: url.hostname, port: url.port, path: "/healthz", headers: { Host: host } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function requestPath(
  origin: string,
  path: string,
): Promise<{ status: number; body: string }> {
  const url = new URL(origin);
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        headers: { Host: url.hostname },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("bootstrap returns the source snapshot and hardened response headers", async () => {
  const { running } = await fixture();
  try {
    const response = await fetch(`${running.origin}/api/v1/bootstrap`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const body = (await response.json()) as {
      version: number;
      sessions: unknown[];
      agents: unknown[];
    };
    assert.equal(body.version, 1);
    assert.equal(body.sessions.length, 1);
    assert.equal(body.agents.length, 1);
  } finally {
    await running.close();
  }
});

test("mutations require CSRF and idempotency, then forward exact session ids", async () => {
  const { running, service } = await fixture();
  try {
    const auth = await bootstrap(running.origin);
    const unauthenticated = await fetch(`${running.origin}/api/v1/sessions/record-1/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(unauthenticated.status, 403);

    const missingKeyHeaders = mutationHeaders(auth);
    delete (missingKeyHeaders as Partial<typeof missingKeyHeaders>)["Idempotency-Key"];
    const missingKey = await fetch(`${running.origin}/api/v1/sessions/record-1/turns`, {
      method: "POST",
      headers: missingKeyHeaders,
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(missingKey.status, 428);

    const accepted = await fetch(`${running.origin}/api/v1/sessions/record-1/turns`, {
      method: "POST",
      headers: mutationHeaders(auth),
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { turnId: "turn-1", admission: "started" });
    assert.deepEqual(service.calls.at(-1), {
      method: "enqueuePrompt",
      input: { acpxRecordId: "record-1", text: "hello", idempotencyKey: "request-12345" },
    });
  } finally {
    await running.close();
  }
});

test("mutations reject cross-origin and cross-site browser requests", async () => {
  const { running } = await fixture();
  try {
    const auth = await bootstrap(running.origin);
    for (const headers of [
      { Origin: "https://evil.example" },
      { "Sec-Fetch-Site": "cross-site" },
    ] satisfies Array<Record<string, string>>) {
      const requestHeaders = new Headers(mutationHeaders(auth));
      for (const [name, value] of Object.entries(headers)) {
        requestHeaders.set(name, value);
      }
      const response = await fetch(`${running.origin}/api/v1/sessions/record-1/turns`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({ text: "hello" }),
      });
      assert.equal(response.status, 403);
    }
  } finally {
    await running.close();
  }
});

test("costly reads and event streams reject hostile browser requests before service work", async () => {
  const { running, service, workspace } = await fixture();
  const providerUrl = `${running.origin}/api/v1/agents/codex/sessions?cwd=${encodeURIComponent(workspace)}`;
  try {
    const hostileHeaders = { "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": "cross-site" };
    const provider = await fetch(providerUrl, {
      headers: hostileHeaders,
    });
    assert.equal(provider.status, 403);
    assert.equal(
      service.calls.some((call) => call.method === "listProviderSessions"),
      false,
    );

    const events = await fetch(`${running.origin}/api/v1/events`, { headers: hostileHeaders });
    assert.equal(events.status, 403);

    const proxiedHttps = await fetch(providerUrl, {
      headers: { Origin: running.origin.replace(/^http:/, "https:") },
    });
    assert.equal(proxiedHttps.status, 200);
    assert.equal(service.calls.filter((call) => call.method === "listProviderSessions").length, 1);

    const unsupportedScheme = await fetch(providerUrl, {
      headers: { Origin: running.origin.replace(/^http:/, "ftp:") },
    });
    assert.equal(unsupportedScheme.status, 403);
    const mismatchedAuthority = await fetch(providerUrl, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(mismatchedAuthority.status, 403);
    assert.equal(service.calls.filter((call) => call.method === "listProviderSessions").length, 1);

    const legitimate = await fetch(providerUrl, {
      headers: { "Sec-Fetch-Site": "same-origin", Origin: running.origin },
    });
    assert.equal(legitimate.status, 200);
    assert.equal(service.calls.filter((call) => call.method === "listProviderSessions").length, 2);
  } finally {
    await running.close();
  }
});

test("provider-session enumeration rejects excess in-flight work per client", async () => {
  const { running, service, workspace } = await fixture({
    providerEnumerationLimit: { global: 1, perClient: 1 },
  });
  const providerUrl = `${running.origin}/api/v1/agents/codex/sessions?cwd=${encodeURIComponent(workspace)}`;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  service.listProviderSessions = async () => {
    markEntered();
    await blocked;
    return { sessions: [] };
  };
  try {
    const first = fetch(providerUrl);
    await entered;
    const refused = await fetch(providerUrl);
    assert.equal(refused.status, 429);
    assert.equal(
      ((await refused.json()) as { error: { code: string } }).error.code,
      "PROVIDER_ENUMERATION_LIMIT",
    );
    release();
    assert.equal((await first).status, 200);
  } finally {
    release();
    await running.close();
  }
});

test("provider-session enumeration requires an explicit allowed workspace", async () => {
  const { running, service } = await fixture();
  try {
    const response = await fetch(`${running.origin}/api/v1/agents/codex/sessions`);
    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "INVALID_INPUT",
    );
    assert.equal(
      service.calls.some((call) => call.method === "listProviderSessions"),
      false,
    );
  } finally {
    await running.close();
  }
});

test("wildcard binds display an explicit allowed host", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-wildcard-display-"));
  const web = join(root, "web");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "ok");
  const running = await startAcpxConsoleServer({
    config: {
      host: "0.0.0.0",
      port: 0,
      trustNetwork: true,
      allowedHosts: ["console.example.test"],
      workspaceRoots: [root],
      stateDir: join(root, "state"),
      staticDir: web,
    },
    service: new MockSessionService(root),
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    assert.match(running.origin, /^http:\/\/console\.example\.test:\d+$/);
    assert.doesNotMatch(running.origin, /0\.0\.0\.0|\[::\]/);
  } finally {
    await running.close();
  }
});

test("an invalid direct wildcard display host fails before subscription", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-invalid-display-"));
  const service = new MockSessionService();
  let subscribed = false;
  service.subscribe = () => {
    subscribed = true;
    return () => undefined;
  };
  await assert.rejects(
    startAcpxConsoleServer({
      config: {
        host: "::0",
        port: 0,
        trustNetwork: true,
        allowedHosts: ["::"],
        workspaceRoots: [root],
        stateDir: join(root, "state"),
        staticDir: join(root, "web"),
      },
      service,
    }),
    /non-wildcard allowed host/,
  );
  assert.equal(subscribed, false);
});

test("JSON request bodies are bounded before parsing", async () => {
  const { running } = await fixture();
  try {
    const auth = await bootstrap(running.origin);
    const response = await fetch(`${running.origin}/api/v1/sessions/record-1/turns`, {
      method: "POST",
      headers: mutationHeaders(auth),
      body: JSON.stringify({ text: "x".repeat(1024 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "BODY_TOO_LARGE",
    );
  } finally {
    await running.close();
  }
});

test("session creation enforces the configured real workspace boundary", async () => {
  const { running, workspace } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "acpx-console-denied-"));
  try {
    const auth = await bootstrap(running.origin);
    const denied = await fetch(`${running.origin}/api/v1/sessions`, {
      method: "POST",
      headers: mutationHeaders(auth),
      body: JSON.stringify({ agentId: "codex", cwd: outside }),
    });
    assert.equal(denied.status, 400);
    const allowed = await fetch(`${running.origin}/api/v1/sessions`, {
      method: "POST",
      headers: mutationHeaders(auth, "request-67890"),
      body: JSON.stringify({ agentId: "codex", cwd: workspace }),
    });
    assert.equal(allowed.status, 201);
    const unsafe = await fetch(`${running.origin}/api/v1/sessions`, {
      method: "POST",
      headers: mutationHeaders(auth, "request-policy-unsafe"),
      body: JSON.stringify({
        agentId: "codex",
        cwd: workspace,
        policy: { defaultAction: "approve" },
      }),
    });
    assert.equal(unsafe.status, 400);
    assert.equal(
      ((await unsafe.json()) as { error: { code: string } }).error.code,
      "INVALID_PERMISSION_POLICY",
    );
  } finally {
    await running.close();
  }
});

test("custom-agent create and adopt routes forward the explicit mode", async () => {
  const { running, service, workspace } = await fixture();
  try {
    const auth = await bootstrap(running.origin);
    const created = await fetch(`${running.origin}/api/v1/sessions`, {
      method: "POST",
      headers: mutationHeaders(auth, "custom-create-mode"),
      body: JSON.stringify({ agentId: "custom-agent", cwd: workspace, mode: "safe" }),
    });
    assert.equal(created.status, 201);
    assert.equal((service.calls.at(-1)?.input as { mode?: string } | undefined)?.mode, "safe");

    const adopted = await fetch(`${running.origin}/api/v1/sessions/adopt`, {
      method: "POST",
      headers: mutationHeaders(auth, "custom-adopt-mode"),
      body: JSON.stringify({
        agentId: "custom-agent",
        providerSessionId: "provider-custom",
        cwd: workspace,
        mode: "review",
      }),
    });
    assert.equal(adopted.status, 201);
    assert.equal((service.calls.at(-1)?.input as { mode?: string } | undefined)?.mode, "review");
  } finally {
    await running.close();
  }
});

test("an unapproved Host header is rejected", async () => {
  const { running } = await fixture();
  try {
    const response = await requestWithHost(running.origin, "evil.example");
    assert.equal(response.status, 403);
    assert.equal(
      (JSON.parse(response.body) as { error: { code: string } }).error.code,
      "HOST_NOT_ALLOWED",
    );
  } finally {
    await running.close();
  }
});

test("SPA routes fall back to installed web assets but API typos remain JSON 404s", async () => {
  const { running } = await fixture();
  try {
    const page = await fetch(`${running.origin}/sessions/record-1`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /ACPX Console/);
    const head = await fetch(`${running.origin}/sessions/record-1`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const api = await fetch(`${running.origin}/api/v1/not-real`);
    assert.equal(api.status, 404);
    assert.equal(api.headers.get("content-type"), "application/json; charset=utf-8");
  } finally {
    await running.close();
  }
});

test("static assets cannot escape the installed web root through symlinks", async () => {
  const { root, running } = await fixture();
  const outside = join(root, "private.txt");
  await writeFile(outside, "TOP-SECRET");
  await symlink(outside, join(root, "web", "leak.txt"));
  try {
    const response = await fetch(`${running.origin}/leak.txt`);
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /TOP-SECRET/);
  } finally {
    await running.close();
  }
});

test("static stream failures close the response without an uncaught process error", async () => {
  const { root, running } = await fixture();
  const blocked = join(root, "web", "blocked.js");
  await writeFile(blocked, "not-readable");
  await chmod(blocked, 0);
  let uncaught: unknown;
  const onUncaught = (error: unknown) => {
    uncaught = error;
  };
  process.once("uncaughtException", onUncaught);
  try {
    const response = await fetch(`${running.origin}/blocked.js`);
    assert.equal(response.status, 500);
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(uncaught, undefined);
  } finally {
    process.off("uncaughtException", onUncaught);
    await running.close();
    await chmod(blocked, 0o600);
  }
});

test("malformed URI escapes are classified as invalid paths", async () => {
  const { running } = await fixture();
  try {
    const response = await requestPath(running.origin, "/%E0%A4%A");
    assert.equal(response.status, 400);
    assert.equal(
      (JSON.parse(response.body) as { error: { code: string } }).error.code,
      "INVALID_PATH",
    );
    const apiResponse = await requestPath(running.origin, "/api/v1/sessions/%E0%A4%A/timeline");
    assert.equal(apiResponse.status, 400);
    assert.equal(
      (JSON.parse(apiResponse.body) as { error: { code: string } }).error.code,
      "INVALID_PATH",
    );
  } finally {
    await running.close();
  }
});

test("timeline cursor errors retain their stable HTTP semantics", async () => {
  const { running, service } = await fixture();
  service.getTranscriptPage = async (input?: { before?: string }) => {
    const before = input?.before;
    const error = new Error(
      before ? "Timeline cursor has expired" : "Timeline cursor is invalid",
    ) as Error & { code: string; earliestCursor?: string };
    error.code = before ? "CURSOR_EXPIRED" : "CURSOR_INVALID";
    error.earliestCursor = before ? "earliest-safe-cursor" : undefined;
    throw error;
  };
  try {
    const invalid = await fetch(`${running.origin}/api/v1/sessions/record-1/timeline`);
    assert.equal(invalid.status, 400);
    assert.equal(
      ((await invalid.json()) as { error: { code: string } }).error.code,
      "CURSOR_INVALID",
    );
    const expired = await fetch(
      `${running.origin}/api/v1/sessions/record-1/timeline?before=old-cursor`,
    );
    assert.equal(expired.status, 410);
    assert.deepEqual(await expired.json(), {
      error: {
        code: "CURSOR_EXPIRED",
        message: "Timeline cursor has expired",
        details: { earliestCursor: "earliest-safe-cursor" },
      },
    });
  } finally {
    await running.close();
  }
});

test("mutation rate limits are bounded per direct client", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-rate-"));
  const web = join(root, "web");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "ok");
  const running = await startAcpxConsoleServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      trustNetwork: false,
      allowedHosts: ["127.0.0.1"],
      workspaceRoots: [root],
      stateDir: join(root, "state"),
      staticDir: web,
    },
    service: new MockSessionService(root),
    mutationRateLimit: { maxRequests: 1, windowMs: 60_000 },
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    const auth = await bootstrap(running.origin);
    const rejected = await fetch(`${running.origin}/api/v1/sessions/record-1/turns`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: auth.cookie,
        "X-CSRF-Token": "wrong-token",
        "Idempotency-Key": "invalid-auth-key",
      },
      body: JSON.stringify({ text: "not authorized" }),
    });
    assert.equal(rejected.status, 403);
    const first = await fetch(`${running.origin}/api/v1/sessions/record-1/turns`, {
      method: "POST",
      headers: mutationHeaders(auth, "rate-key-111"),
      body: JSON.stringify({ text: "one" }),
    });
    assert.equal(first.status, 202);
    const limited = await fetch(`${running.origin}/api/v1/sessions/record-1/turns`, {
      method: "POST",
      headers: mutationHeaders(auth, "rate-key-222"),
      body: JSON.stringify({ text: "two" }),
    });
    assert.equal(limited.status, 429);
  } finally {
    await running.close();
  }
});

test("untyped service failures do not expose adapter details or local paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-error-"));
  const web = join(root, "web");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "ok");
  const service = new MockSessionService();
  service.listSessions = async () => {
    throw new Error("provider token SECRET from /Users/operator/private.json");
  };
  const logged: unknown[] = [];
  const running = await startAcpxConsoleServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      trustNetwork: false,
      allowedHosts: ["127.0.0.1"],
      workspaceRoots: [root],
      stateDir: join(root, "state"),
      staticDir: web,
    },
    service,
    logger: {
      info() {},
      warn() {},
      error(value) {
        logged.push(value);
      },
    },
  });
  try {
    const response = await fetch(`${running.origin}/api/v1/sessions`);
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.doesNotMatch(text, /SECRET|operator|private\.json/);
    assert.match(text, /INTERNAL_ERROR/);
    assert.equal(logged.length, 1);
  } finally {
    await running.close();
  }
});

test("structurally shaped service failures cannot expose messages or details", async () => {
  const { running, service } = await fixture();
  service.listSessions = async () => {
    throw Object.assign(new Error("provider token SECRET from /Users/operator/private.json"), {
      statusCode: 400,
      details: { token: "SECRET" },
    });
  };
  try {
    const response = await fetch(`${running.origin}/api/v1/sessions`);
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.doesNotMatch(text, /SECRET|operator|private\.json|token/);
    assert.match(text, /INTERNAL_ERROR/);
  } finally {
    await running.close();
  }
});

test("unknown session-start results require reconciliation instead of reporting generic failure", async () => {
  const { running, service, workspace } = await fixture();
  service.createSession = async () => {
    throw Object.assign(new Error("provider may have created session provider-secret"), {
      code: "SESSION_START_RESULT_UNKNOWN",
    });
  };
  try {
    const auth = await bootstrap(running.origin);
    const response = await fetch(`${running.origin}/api/v1/sessions`, {
      method: "POST",
      headers: mutationHeaders(auth, "unknown-create-result"),
      body: JSON.stringify({ agentId: "codex", cwd: workspace }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: {
        code: "SESSION_START_RESULT_UNKNOWN",
        message: "Session start result is unknown; reconcile before retrying",
      },
    });
  } finally {
    await running.close();
  }
});

test("durable idempotency retention failures preserve their typed HTTP contract", async () => {
  const { running, service, workspace } = await fixture();
  const cases = [
    {
      code: "IDEMPOTENCY_RECEIPT_RETIRED",
      status: 409,
      message: "Idempotency receipt was retired; reconcile before choosing a new key",
    },
    {
      code: "IDEMPOTENCY_SESSION_PRUNED",
      status: 410,
      message: "The session recorded by this mutation was pruned",
    },
    {
      code: "IDEMPOTENCY_LEDGER_FULL",
      status: 507,
      message: "The durable mutation ledger is full",
    },
  ] as const;
  try {
    const auth = await bootstrap(running.origin);
    for (const current of cases) {
      service.createSession = async () => {
        throw Object.assign(new Error("receipt SECRET from /Users/operator/private.json"), {
          code: current.code,
        });
      };
      const response = await fetch(`${running.origin}/api/v1/sessions`, {
        method: "POST",
        headers: mutationHeaders(auth, `retention-${current.code.toLowerCase()}`),
        body: JSON.stringify({ agentId: "codex", cwd: workspace }),
      });
      assert.equal(response.status, current.status);
      assert.deepEqual(await response.json(), {
        error: { code: current.code, message: current.message },
      });
    }
  } finally {
    await running.close();
  }
});

test("invalid pending answers and inaccessible workspaces are typed client errors", async () => {
  const { root, running } = await fixture();
  try {
    const auth = await bootstrap(running.origin);
    const badAnswer = await fetch(
      `${running.origin}/api/v1/sessions/record-1/pending/request-1/responses`,
      {
        method: "POST",
        headers: mutationHeaders(auth, "bad-answer-key"),
        body: JSON.stringify({ response: { unsupported: true } }),
      },
    );
    assert.equal(badAnswer.status, 400);
    assert.equal(
      ((await badAnswer.json()) as { error: { code: string } }).error.code,
      "INVALID_INPUT",
    );

    const missingWorkspace = await fetch(`${running.origin}/api/v1/sessions`, {
      method: "POST",
      headers: mutationHeaders(auth, "missing-workspace-key"),
      body: JSON.stringify({ agentId: "codex", cwd: join(root, "does-not-exist") }),
    });
    assert.equal(missingWorkspace.status, 400);
    assert.equal(
      ((await missingWorkspace.json()) as { error: { code: string } }).error.code,
      "INVALID_INPUT",
    );
  } finally {
    await running.close();
  }
});

test("a failed listen unsubscribes and disposes the service", async () => {
  const { root, running } = await fixture();
  const service = new MockSessionService();
  let unsubscribed = 0;
  let disposed = 0;
  service.subscribe = () => () => {
    unsubscribed += 1;
  };
  service.dispose = () => {
    disposed += 1;
  };
  const occupiedPort = Number(new URL(running.origin).port);
  try {
    await assert.rejects(
      startAcpxConsoleServer({
        config: {
          host: "127.0.0.1",
          port: occupiedPort,
          trustNetwork: false,
          allowedHosts: ["127.0.0.1"],
          workspaceRoots: [root],
          stateDir: join(root, "other-state"),
          staticDir: join(root, "web"),
        },
        service,
        logger: { info() {}, warn() {}, error() {} },
      }),
      /EADDRINUSE/,
    );
    assert.equal(unsubscribed, 1);
    assert.equal(disposed, 1);
  } finally {
    await running.close();
  }
});

test("a failed service subscription disposes the service before startup returns", async () => {
  const root = await mkdtemp(join(tmpdir(), "acpx-console-subscribe-failure-"));
  const web = join(root, "web");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "ok");
  const service = new MockSessionService();
  let disposed = 0;
  service.subscribe = () => {
    throw new Error("subscription failed");
  };
  service.dispose = () => {
    disposed += 1;
  };

  await assert.rejects(
    startAcpxConsoleServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        trustNetwork: false,
        allowedHosts: ["127.0.0.1"],
        workspaceRoots: [root],
        stateDir: join(root, "state"),
        staticDir: web,
      },
      service,
      logger: { info() {}, warn() {}, error() {} },
    }),
    /subscription failed/,
  );
  assert.equal(disposed, 1);
});

test("session detail, provider inventory, timeline, pending, cancellation, response and close routes keep exact ids", async () => {
  const { running, service, workspace } = await fixture();
  try {
    const auth = await bootstrap(running.origin);
    const detail = await fetch(`${running.origin}/api/v1/sessions/record-1`);
    assert.equal(detail.status, 200);
    assert.equal(
      ((await detail.json()) as { session: { acpxRecordId: string } }).session.acpxRecordId,
      "record-1",
    );
    const provider = await fetch(
      `${running.origin}/api/v1/agents/codex/sessions?cwd=${encodeURIComponent(workspace)}&cursor=next`,
    );
    assert.equal(provider.status, 200);
    assert.equal(((await provider.json()) as { sessions: unknown[] }).sessions.length, 1);
    assert.equal(service.calls.at(-1)?.method, "listProviderSessions");

    const timeline = await fetch(`${running.origin}/api/v1/sessions/record-1/timeline?limit=20`);
    assert.deepEqual(await timeline.json(), { items: [], hasMore: false, coverage: "complete" });
    const pending = await fetch(`${running.origin}/api/v1/sessions/record-1/pending`);
    assert.equal(((await pending.json()) as { pending: unknown[] }).pending.length, 1);

    const answered = await fetch(
      `${running.origin}/api/v1/sessions/record-1/pending/request-1/responses`,
      {
        method: "POST",
        headers: mutationHeaders(auth, "answer-key-123"),
        body: JSON.stringify({ response: { type: "select", option_id: "allow" } }),
      },
    );
    assert.equal(answered.status, 200);
    assert.equal(service.calls.at(-1)?.method, "respondToPendingRequest");

    const cancelled = await fetch(
      `${running.origin}/api/v1/sessions/record-1/turns/turn-1/cancel`,
      {
        method: "POST",
        headers: mutationHeaders(auth, "cancel-key-123"),
        body: "{}",
      },
    );
    assert.equal(cancelled.status, 202);
    assert.equal(service.calls.at(-1)?.method, "cancelTurn");
    assert.deepEqual(service.calls.at(-1)?.input, {
      acpxRecordId: "record-1",
      turnId: "turn-1",
      idempotencyKey: "cancel-key-123",
    });

    const closed = await fetch(`${running.origin}/api/v1/sessions/record-1/close`, {
      method: "POST",
      headers: mutationHeaders(auth, "close-key-1234"),
      body: "{}",
    });
    assert.equal(closed.status, 200);
    assert.deepEqual(await closed.json(), {
      close: {
        session: { ...service.sessions[0], sessionState: "closed" },
        localClose: "closed",
        providerClose: { status: "confirmed" },
      },
    });
    assert.equal(service.calls.at(-1)?.method, "closeSession");
  } finally {
    await running.close();
  }
});

test("an ambiguous prompt admission is returned as a durable unknown HTTP receipt", async () => {
  const { running, service } = await fixture();
  service.enqueuePrompt = async (input) => {
    service.calls.push({ method: "enqueuePrompt", input });
    return { turnId: "turn-unknown", admission: "unknown" };
  };
  try {
    const auth = await bootstrap(running.origin);
    const response = await fetch(`${running.origin}/api/v1/sessions/record-1/turns`, {
      method: "POST",
      headers: mutationHeaders(auth, "ambiguous-http-key"),
      body: JSON.stringify({ text: "run this once" }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { turnId: "turn-unknown", admission: "unknown" });
    assert.equal(service.calls.filter(({ method }) => method === "enqueuePrompt").length, 1);
  } finally {
    await running.close();
  }
});

test("close reports local success and a degraded provider outcome separately", async () => {
  const { running, service } = await fixture();
  service.closeSession = async (input) => {
    service.calls.push({ method: "closeSession", input });
    return {
      session: { ...service.sessions[0], sessionState: "closed" },
      localClose: "closed",
      providerClose: { status: "degraded", reason: "provider_error" },
    };
  };
  try {
    const auth = await bootstrap(running.origin);
    const response = await fetch(`${running.origin}/api/v1/sessions/record-1/close`, {
      method: "POST",
      headers: mutationHeaders(auth, "close-degraded-key"),
      body: "{}",
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      close: { localClose: string; providerClose: { status: string; reason?: string } };
    };
    assert.equal(result.close.localClose, "closed");
    assert.deepEqual(result.close.providerClose, {
      status: "degraded",
      reason: "provider_error",
    });
  } finally {
    await running.close();
  }
});

test("event streams have an explicit client cap", async () => {
  const { running } = await fixture();
  const streams: Response[] = [];
  try {
    for (let index = 0; index < 64; index++) {
      const response = await fetch(`${running.origin}/api/v1/events`);
      assert.equal(response.status, 200);
      streams.push(response);
    }
    const refused = await fetch(`${running.origin}/api/v1/events`);
    assert.equal(refused.status, 503);
    assert.equal(
      ((await refused.json()) as { error: { code: string } }).error.code,
      "SSE_CAPACITY",
    );
  } finally {
    await Promise.all(streams.map(async (response) => await response.body?.cancel()));
    await running.close();
  }
});

test("event streams replay retained ids and reset clients outside the replay window", async () => {
  const { running, service } = await fixture();
  const readUntil = async (
    headers: HeadersInit,
    pattern: RegExp,
    afterConnect?: () => void,
  ): Promise<string> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(`${running.origin}/api/v1/events`, {
      headers,
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    try {
      afterConnect?.();
      while (!pattern.test(body)) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        body += decoder.decode(next.value, { stream: true });
      }
      return body;
    } finally {
      clearTimeout(timeout);
      await reader.cancel();
    }
  };
  try {
    await readUntil({}, /id: 2\n/, () => {
      service.emit({ type: "sessions" });
      service.emit({ type: "session", acpxRecordId: "record-1" });
    });
    const replay = await readUntil({ "Last-Event-ID": "1" }, /id: 2\n/);
    assert.doesNotMatch(replay, /id: 1\n/);
    assert.match(replay, /event: session\n/);

    await readUntil({ "Last-Event-ID": "2" }, /id: 514\n/, () => {
      for (let index = 0; index < 512; index++) {
        service.emit({ type: "timeline", acpxRecordId: "record-1", cursor: String(index) });
      }
    });
    const reset = await readUntil({ "Last-Event-ID": "0" }, /event: reset\n/);
    assert.match(reset, /event: reset\n/);
  } finally {
    await running.close();
  }
});

test("event streams reset and remain usable after a transient session projection failure", async () => {
  const { running, service } = await fixture();
  const originalGetSession = service.getSession.bind(service);
  let failOnce = true;
  service.getSession = async (input) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("transient projection failure");
    }
    return await originalGetSession(input);
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${running.origin}/api/v1/events`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";

    service.emit({ type: "session", acpxRecordId: "record-1" });
    service.emit({ type: "session", acpxRecordId: "outside-record" });
    service.emit({ type: "session", acpxRecordId: "record-1" });

    while (!body.includes("id: 2\nevent: session\n")) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      body += decoder.decode(next.value, { stream: true });
    }

    assert.match(body, /id: 1\nevent: reset\ndata: {"type":"reset"}\n\n/);
    assert.match(
      body,
      /id: 2\nevent: session\ndata: {"type":"session","acpxRecordId":"record-1"}\n\n/,
    );
    assert.doesNotMatch(body.match(/event: reset\ndata: ([^\n]+)/)?.[1] ?? "", /acpxRecordId/);
    assert.doesNotMatch(body, /outside-record/);
    await reader.cancel();
  } finally {
    clearTimeout(timeout);
    await running.close();
  }
});

test("server close destroys a lingering partial HTTP connection", async () => {
  const { running } = await fixture();
  const url = new URL(running.origin);
  const socket = createConnection(Number(url.port), url.hostname);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(`GET /healthz HTTP/1.1\r\nHost: ${url.hostname}\r\n`);
  const socketClosed = new Promise<void>((resolve) => socket.once("close", resolve));
  await Promise.race([
    Promise.all([running.close(), socketClosed]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("console close hung on a partial HTTP request")), 1_000),
    ),
  ]);
  assert.equal(socket.destroyed, true);
});
