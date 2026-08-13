#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const consolePackageDir = path.join(root, "packages", "console");
const consoleBin = path.join(consolePackageDir, "dist", "cli.js");
const consoleStaticDir = path.join(consolePackageDir, "dist", "web");
const mockAgentPath = path.join(root, "dist-test", "test", "mock-agent.js");
const DEFAULT_TIMEOUT_MS = 20_000;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const result = { code, signal, stdout, stderr };
      if (code === 0 || options.allowFailure) {
        resolve(result);
      } else {
        reject(
          new Error(`${command} ${args.join(" ")} failed (${code ?? signal})\n${stdout}${stderr}`),
        );
      }
    });
  });
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitFor(label, read, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined && value !== false && value !== null) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(
    `Timed out waiting for ${label}${detail}`,
    lastError ? { cause: lastError } : undefined,
  );
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function processCommand(pid) {
  if (!processAlive(pid)) {
    return "";
  }
  const result = await run("ps", ["-p", String(pid), "-o", "command="], {
    allowFailure: true,
  });
  return result.stdout.trim();
}

async function terminateOwnedProcess(pid, expectedFragments) {
  if (!processAlive(pid)) {
    return;
  }
  const command = await processCommand(pid);
  if (!expectedFragments.some((fragment) => command.includes(fragment))) {
    throw new Error(`Refusing to terminate unexpected pid ${pid}: ${command}`);
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
  await waitFor(`pid ${pid} to exit`, () => !processAlive(pid) || undefined, 5_000).catch(
    async () => {
      const current = await processCommand(pid);
      if (expectedFragments.some((fragment) => current.includes(fragment))) {
        process.kill(pid, "SIGKILL");
      }
    },
  );
}

class ConsoleApi {
  constructor(origin) {
    this.origin = origin;
    this.csrfToken = undefined;
    this.cookie = undefined;
    this.mutationIndex = 0;
  }

  async request(pathname, options = {}) {
    const headers = new Headers(options.headers);
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    const method = options.method ?? "GET";
    let response;
    try {
      response = await fetch(`${this.origin}${pathname}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      throw new Error(`${method} ${pathname} did not complete`, { cause: error });
    }
    const text = await response.text();
    let body;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON from ${pathname} (${response.status}): ${text}`, {
        cause: error,
      });
    }
    if (options.expectedStatus !== undefined) {
      assert.equal(response.status, options.expectedStatus, `${pathname}: ${text}`);
    } else {
      assert(response.ok, `${pathname} returned ${response.status}: ${text}`);
    }
    return { response, body };
  }

  async bootstrap() {
    const { response, body } = await this.request("/api/v1/bootstrap", { expectedStatus: 200 });
    const setCookie = response.headers.get("set-cookie");
    assert(setCookie, "bootstrap must establish a CSRF cookie");
    this.cookie = setCookie.split(";", 1)[0];
    this.csrfToken = body.csrfToken;
    assert.equal(typeof this.csrfToken, "string");
    return body;
  }

  async get(pathname) {
    return (await this.request(pathname, { expectedStatus: 200 })).body;
  }

  async mutate(pathname, body, expectedStatus) {
    assert(this.cookie && this.csrfToken, "bootstrap before mutating");
    this.mutationIndex += 1;
    return (
      await this.request(pathname, {
        method: "POST",
        expectedStatus,
        body,
        headers: {
          Cookie: this.cookie,
          "X-CSRF-Token": this.csrfToken,
          "Idempotency-Key": `product-smoke-${this.mutationIndex}-${randomUUID()}`,
          Origin: this.origin,
          "Sec-Fetch-Site": "same-origin",
        },
      })
    ).body;
  }
}

class SseProbe {
  constructor(origin) {
    this.origin = origin;
    this.frames = [];
    this.controller = new AbortController();
    this.error = undefined;
    this.done = undefined;
  }

  async start() {
    const response = await fetch(`${this.origin}/api/v1/events`, {
      headers: { Accept: "text/event-stream" },
      signal: this.controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/u);
    assert(response.body);
    this.done = this.consume(response.body).catch((error) => {
      if (!this.controller.signal.aborted) {
        this.error = error;
      }
    });
  }

  async consume(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = buffered.indexOf("\n\n")) >= 0) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        this.capture(frame);
      }
      if (done) {
        return;
      }
    }
  }

  capture(raw) {
    if (raw === "" || raw.startsWith(":")) {
      return;
    }
    const fields = new Map();
    for (const line of raw.split("\n")) {
      const separator = line.indexOf(":");
      if (separator >= 0) {
        fields.set(line.slice(0, separator), line.slice(separator + 1).trimStart());
      }
    }
    const data = fields.get("data");
    if (!data) {
      return;
    }
    this.frames.push({
      id: fields.get("id"),
      event: fields.get("event"),
      data: JSON.parse(data),
    });
  }

  async waitFor(label, predicate, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return await waitFor(
      `SSE ${label}`,
      () => {
        if (this.error) {
          throw this.error;
        }
        return this.frames.find(predicate);
      },
      timeoutMs,
    );
  }

  async stop() {
    this.controller.abort();
    await this.done;
  }
}

function timelineEvents(page) {
  return page.items.filter((item) => item.schema === "acpx.session_event.v1");
}

function lifecycleEvents(page, type, turnId) {
  return timelineEvents(page).filter(
    (item) =>
      item.turn_id === turnId &&
      item.payload?.kind === "lifecycle" &&
      item.payload.event?.type === type,
  );
}

function assistantText(page) {
  return timelineEvents(page)
    .filter(
      (item) =>
        item.payload?.kind === "acp" &&
        item.payload.message?.method === "session/update" &&
        item.payload.message.params?.update?.sessionUpdate === "agent_message_chunk",
    )
    .map((item) => item.payload.message.params.update.content?.text)
    .filter((text) => typeof text === "string")
    .join("\n");
}

function promptTexts(page) {
  return timelineEvents(page)
    .filter(
      (item) => item.payload?.kind === "acp" && item.payload.message?.method === "session/prompt",
    )
    .map((item) =>
      (item.payload.message.params?.prompt ?? [])
        .map((block) => (block?.type === "text" ? block.text : ""))
        .join(""),
    );
}

async function readCallLog(callLog) {
  const content = await fs.readFile(callLog, "utf8").catch(() => "");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function ownerLease(homeDir, sessionId) {
  const queueDir = path.join(homeDir, ".acpx", "queues");
  const names = await fs.readdir(queueDir).catch(() => []);
  for (const name of names.filter((value) => value.endsWith(".lock"))) {
    const filePath = path.join(queueDir, name);
    try {
      const value = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (value.sessionId === sessionId) {
        return { ...value, filePath };
      }
    } catch {
      // A concurrently rotating lease will be retried by the caller.
    }
  }
  return undefined;
}

async function main() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-console-product-smoke-"));
  const homeDir = path.join(scratch, "home");
  const workspace = path.join(scratch, "workspace");
  const stateDir = path.join(scratch, "console-state");
  const callLog = path.join(scratch, "mock-calls.ndjson");
  const closeMarker = path.join(scratch, "closed-sessions.txt");
  const trackedPids = new Set();
  const env = { ...process.env, HOME: homeDir };
  delete env.NODE_V8_COVERAGE;
  let consoleRunning = false;
  let sse;
  let api;
  let sessionId;

  try {
    await Promise.all([
      fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true }),
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(stateDir, { recursive: true }),
    ]);
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            mock: {
              argv: [
                process.execPath,
                mockAgentPath,
                "--supports-resume-session",
                "--supports-list-sessions",
                "--supports-close-session",
                "--call-log",
                callLog,
                "--close-session-marker",
                closeMarker,
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    if (process.env.ACPX_CONSOLE_SMOKE_SKIP_BUILD !== "1") {
      await run("pnpm", ["run", "build"], { inherit: true });
      await run("pnpm", ["run", "build:test"], { inherit: true });
      await run("pnpm", ["--filter", "acpx-console", "build"], { inherit: true });
    }
    await Promise.all([
      fs.access(consoleBin),
      fs.access(consoleStaticDir),
      fs.access(mockAgentPath),
    ]);

    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const startArgs = [
      consoleBin,
      "start",
      "--detach",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--workspace-root",
      workspace,
      "--state-dir",
      stateDir,
      "--static-dir",
      consoleStaticDir,
    ];
    const startConsole = async () => {
      const started = await run(process.execPath, startArgs, { env });
      assert.match(started.stdout, /ACPX Console started/u);
      consoleRunning = true;
      const status = await run(
        process.execPath,
        [consoleBin, "status", "--json", "--state-dir", stateDir],
        { env },
      );
      const statusValue = JSON.parse(status.stdout);
      assert.equal(statusValue.status, "running");
      assert.equal(statusValue.record.port, port);
      trackedPids.add(statusValue.record.pid);
    };
    const stopConsole = async () => {
      if (!consoleRunning) {
        return;
      }
      const stopped = await run(process.execPath, [consoleBin, "stop", "--state-dir", stateDir], {
        env,
      });
      assert.match(stopped.stdout, /Stopped ACPX Console/u);
      consoleRunning = false;
    };

    await startConsole();
    api = new ConsoleApi(origin);
    const bootstrap = await api.bootstrap();
    const canonicalWorkspace = await fs.realpath(workspace);
    assert(bootstrap.agents.some((agent) => agent.agentId === "mock"));
    assert.deepEqual(bootstrap.workspaceRoots, [canonicalWorkspace]);
    sse = new SseProbe(origin);
    await sse.start();

    const created = await api.mutate(
      "/api/v1/sessions",
      {
        agentId: "mock",
        cwd: workspace,
        name: "product-smoke",
        mode: "default",
        policy: "defer-risky",
      },
      201,
    );
    sessionId = created.session.acpxRecordId;
    assert.equal(created.session.ownerState, "absent");
    assert.equal(created.session.turnState, "idle");
    assert.equal(
      (await readCallLog(callLog)).some((entry) => entry.method === "session/prompt"),
      false,
      "creating a session must not prompt it",
    );
    await sse.waitFor(
      "session creation invalidation",
      (frame) => frame.event === "sessions" && frame.data.acpxRecordId === sessionId,
    );

    const sessionPath = `/api/v1/sessions/${encodeURIComponent(sessionId)}`;
    const timelinePath = `${sessionPath}/timeline?limit=500`;
    const pendingPath = `${sessionPath}/pending`;
    const enqueue = async (text) => await api.mutate(`${sessionPath}/turns`, { text }, 202);
    const timeline = async () => await api.get(timelinePath);

    const permissionTurn = await enqueue("permission execute Run product smoke");
    const permission = await waitFor("parked permission", async () => {
      const entries = (await api.get(pendingPath)).pending;
      return entries.find((entry) => entry.kind === "permission" && entry.state === "pending");
    });
    assert.equal(permission.title, "Run product smoke");
    await sse.waitFor(
      "permission invalidation",
      (frame) => frame.event === "pending" && frame.data.acpxRecordId === sessionId,
    );
    assert.equal((await api.get(sessionPath)).session.turnState, "waiting_permission");
    const permissionAnswer = await api.mutate(
      `${pendingPath}/${encodeURIComponent(permission.requestId)}/responses`,
      { response: { type: "select", option_id: "allow" } },
      200,
    );
    assert.equal(permissionAnswer.pending.state, "answered");
    await waitFor("permission turn completion", async () => {
      const page = await timeline();
      return lifecycleEvents(page, "turn_completed", permissionTurn.turnId)[0];
    });
    assert.match(assistantText(await timeline()), /permission selected:allow/u);

    const requestedSchema = {
      type: "object",
      properties: {
        choice: {
          type: "string",
          oneOf: [
            { const: "A", title: "Choice A" },
            { const: "B", title: "Choice B" },
          ],
        },
      },
      required: ["choice"],
    };
    const elicitationTurn = await enqueue(
      `elicit ${JSON.stringify(requestedSchema)} Pick a smoke-test choice`,
    );
    const elicitation = await waitFor("parked elicitation", async () => {
      const entries = (await api.get(pendingPath)).pending;
      return entries.find((entry) => entry.kind === "elicitation" && entry.state === "pending");
    });
    assert.equal(elicitation.title, "Pick a smoke-test choice");
    assert.deepEqual(elicitation.schema, requestedSchema);
    assert.equal((await api.get(sessionPath)).session.turnState, "waiting_elicitation");
    const elicitationAnswer = await api.mutate(
      `${pendingPath}/${encodeURIComponent(elicitation.requestId)}/responses`,
      { response: { type: "accept", content: { choice: "B" } } },
      200,
    );
    assert.equal(elicitationAnswer.pending.state, "answered");
    await waitFor("elicitation turn completion", async () => {
      const page = await timeline();
      return lifecycleEvents(page, "turn_completed", elicitationTurn.turnId)[0];
    });
    assert.match(assistantText(await timeline()), /elicitation accepted:\{"choice":"B"\}/u);

    const firstQueuedTurn = await enqueue("stream-sleep 10000 queue-first-live");
    await waitFor("live transcript chunk", async () => {
      const page = await timeline();
      return assistantText(page).includes("queue-first-live") ? page : undefined;
    });
    const running = (await api.get(sessionPath)).session;
    assert.equal(running.activeTurnId, firstQueuedTurn.turnId);
    assert.equal(running.turnState, "running");
    const secondQueuedTurn = await enqueue("sleep 0");
    assert.equal(secondQueuedTurn.admission, "queued");
    await waitFor("second prompt queue admission", async () => {
      const session = (await api.get(sessionPath)).session;
      return session.activeTurnId === firstQueuedTurn.turnId && session.queue.depth >= 1
        ? session
        : undefined;
    });
    const cancelled = await api.mutate(
      `${sessionPath}/turns/${encodeURIComponent(firstQueuedTurn.turnId)}/cancel`,
      {},
      202,
    );
    assert.equal(cancelled.turnId, firstQueuedTurn.turnId);
    await waitFor("cancelled first and completed second turn", async () => {
      const page = await timeline();
      return lifecycleEvents(page, "turn_cancelled", firstQueuedTurn.turnId).length > 0 &&
        lifecycleEvents(page, "turn_completed", secondQueuedTurn.turnId).length > 0
        ? page
        : undefined;
    });
    const queuedPage = await timeline();
    const prompts = promptTexts(queuedPage);
    const firstPromptIndex = prompts.indexOf("stream-sleep 10000 queue-first-live");
    const secondPromptIndex = prompts.indexOf("sleep 0");
    assert(firstPromptIndex >= 0 && secondPromptIndex > firstPromptIndex, prompts.join(" | "));
    assert.match(assistantText(queuedPage), /slept 0ms/u);
    assert.equal((await api.get(sessionPath)).session.queue.depth, 0);
    const queuedPromptCalls = (await readCallLog(callLog))
      .filter((entry) => entry.method === "session/prompt")
      .map((entry) => entry.text);
    const firstCallIndex = queuedPromptCalls.indexOf("stream-sleep 10000 queue-first-live");
    const secondCallIndex = queuedPromptCalls.indexOf("sleep 0");
    assert(firstCallIndex >= 0 && secondCallIndex > firstCallIndex, queuedPromptCalls.join(" | "));
    await sse.waitFor(
      "live transcript invalidation",
      (frame) => frame.event === "timeline" && frame.data.acpxRecordId === sessionId,
    );

    const oldOwner = await waitFor("queue owner lease", () => ownerLease(homeDir, sessionId));
    trackedPids.add(oldOwner.pid);
    assert(processAlive(oldOwner.pid));
    const preRestartCalls = await readCallLog(callLog);
    const preRestartAgentPids = new Set(
      preRestartCalls
        .filter((entry) => entry.method === "session/prompt")
        .map((entry) => entry.pid),
    );
    await terminateOwnedProcess(oldOwner.pid, [consoleBin, "__queue-owner"]);
    const restartedTurn = await enqueue("sleep 1");
    await waitFor("turn after owner restart", async () => {
      const page = await timeline();
      return lifecycleEvents(page, "turn_completed", restartedTurn.turnId)[0];
    });
    const newOwner = await waitFor("replacement queue owner", async () => {
      const lease = await ownerLease(homeDir, sessionId);
      return lease && lease.pid !== oldOwner.pid ? lease : undefined;
    });
    trackedPids.add(newOwner.pid);
    const postRestartCalls = await readCallLog(callLog);
    const replacementPrompt = postRestartCalls.find(
      (entry) => entry.method === "session/prompt" && entry.text === "sleep 1",
    );
    assert(replacementPrompt);
    assert.equal(preRestartAgentPids.has(replacementPrompt.pid), false);
    const replacementCalls = postRestartCalls.filter(
      (entry) => entry.pid === replacementPrompt.pid,
    );
    const replacementResumeIndex = replacementCalls.findIndex(
      (entry) => entry.method === "session/resume",
    );
    const replacementPromptIndex = replacementCalls.findIndex(
      (entry) => entry.method === "session/prompt" && entry.text === "sleep 1",
    );
    assert(replacementResumeIndex >= 0);
    assert(replacementPromptIndex > replacementResumeIndex);

    await sse.stop();
    sse = undefined;
    await stopConsole();
    await startConsole();
    api = new ConsoleApi(origin);
    const restartedBootstrap = await api.bootstrap();
    assert(restartedBootstrap.sessions.some((session) => session.acpxRecordId === sessionId));
    const persistedTimeline = await api.get(timelinePath);
    assert.equal(persistedTimeline.coverage, "complete");
    assert.equal(persistedTimeline.writeError, undefined);
    const persistedText = assistantText(persistedTimeline);
    assert.match(persistedText, /permission selected:allow/u);
    assert.match(persistedText, /elicitation accepted:\{"choice":"B"\}/u);
    assert.match(persistedText, /queue-first-live/u);
    assert.match(persistedText, /slept 1ms/u);

    const closed = await api.mutate(`${sessionPath}/close`, {}, 200);
    assert.equal(closed.session.sessionState, "closed");
    await waitFor("provider close marker", async () => {
      const marker = await fs.readFile(closeMarker, "utf8").catch(() => "");
      return marker.trim() !== "" ? marker : undefined;
    });
    await waitFor("queue owner shutdown after close", () =>
      !processAlive(newOwner.pid) ? true : undefined,
    );
    trackedPids.delete(newOwner.pid);

    await stopConsole();
    const stopped = await run(
      process.execPath,
      [consoleBin, "status", "--json", "--state-dir", stateDir],
      { env, allowFailure: true },
    );
    assert.equal(stopped.code, 1);
    assert.equal(JSON.parse(stopped.stdout).status, "stopped");

    console.log(
      JSON.stringify(
        {
          status: "passed",
          sessionId,
          checks: [
            "create-without-prompt",
            "sse-invalidation-and-live-transcript",
            "permission-response",
            "elicitation-response",
            "two-prompt-order-and-cancel",
            "owner-restart",
            "console-restart-persistence",
            "close",
          ],
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const diagnostics = await Promise.all(
      ["console.log", "console.error.log"].map(async (name) => {
        const content = await fs.readFile(path.join(stateDir, name), "utf8").catch(() => "");
        return content ? `\n--- ${name} ---\n${content}` : "";
      }),
    );
    throw new Error(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}${diagnostics.join("")}`,
      { cause: error },
    );
  } finally {
    await sse?.stop().catch(() => undefined);
    if (consoleRunning) {
      await run(process.execPath, [consoleBin, "stop", "--state-dir", stateDir], {
        env,
        allowFailure: true,
      }).catch(() => undefined);
    }
    if (sessionId) {
      const lease = await ownerLease(homeDir, sessionId);
      if (lease?.pid) {
        trackedPids.add(lease.pid);
      }
    }
    const calls = await readCallLog(callLog).catch(() => []);
    for (const call of calls) {
      if (Number.isInteger(call.pid)) {
        trackedPids.add(call.pid);
      }
    }
    for (const pid of trackedPids) {
      await terminateOwnedProcess(pid, [consoleBin, mockAgentPath, "__queue-owner"]).catch(
        () => undefined,
      );
    }
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

await main();
