import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runPromptTurn } from "../src/runtime/engine/prompt-turn.js";
import { TurnCompletionTracker } from "../src/runtime/engine/turn-completion.js";
import {
  createSessionConversation,
  recordPromptSubmission,
  recordSessionUpdate,
} from "../src/session/conversation-model.js";
import {
  extractAgentMessageChunkText,
  extractJsonRpcId,
  parseJsonRpcOutputLines,
} from "./jsonrpc-test-helpers.js";
import { queuePaths } from "./queue-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const FLOW_FIXTURE_PATH = fileURLToPath(new URL("./fixtures/flow-branch.flow.js", import.meta.url));
const FLOW_SHELL_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/flow-shell.flow.js", import.meta.url),
);
const FLOW_INTERRUPT_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/flow-interrupt.flow.js", import.meta.url),
);
const FLOW_ACP_DISCONNECT_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/flow-acp-disconnect.flow.js", import.meta.url),
);
const FLOW_WAIT_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/flow-wait.flow.js", import.meta.url),
);
const FLOW_WORKDIR_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/flow-workdir.flow.js", import.meta.url),
);
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const LOAD_CAPABLE_MOCK_AGENT_COMMAND = `${MOCK_AGENT_COMMAND} --supports-load-session`;
const RESUME_CAPABLE_MOCK_AGENT_COMMAND = `${MOCK_AGENT_COMMAND} --supports-resume-session`;

const unsafeCodeCharEscapes = Object.freeze({
  "<": "\\u003C",
  ">": "\\u003E",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
});

type CliRunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type CliRunOptions = {
  timeoutMs?: number;
  cwd?: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
};

test("integration: exec echo baseline", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli([...baseExecArgs(cwd), "echo hello"], homeDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: an empty persistent session can start on an agent without session reuse", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const callLog = path.join(homeDir, "first-prompt-no-reuse.ndjson");
    const agentCommand = `${MOCK_AGENT_COMMAND} --call-log ${JSON.stringify(callLog)}`;
    const agentArgs = ["--agent", agentCommand, "--approve-all", "--cwd", cwd];

    try {
      const created = await runCli([...agentArgs, "--format", "json", "sessions", "new"], homeDir);
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as { acpxRecordId?: string };
      const recordId = createdPayload.acpxRecordId;
      assert.equal(typeof recordId, "string");

      const prompt = await runCli(
        [...agentArgs, "--format", "quiet", "prompt", "echo first turn"],
        homeDir,
      );
      assert.equal(prompt.code, 0, `${prompt.stdout}${prompt.stderr}`);
      assert.match(prompt.stdout, /first turn/);

      const calls = await readMockAgentCalls(callLog);
      const newSessions = calls.filter((call) => call.method === "session/new");
      assert.equal(newSessions.length, 2);
      assert.notEqual(newSessions[0]?.sessionId, newSessions[1]?.sessionId);
      assert.equal(calls.filter((call) => call.method === "session/prompt").length, 1);

      const storedRecord = JSON.parse(
        await fs.readFile(sessionRecordPath(homeDir, recordId as string), "utf8"),
      ) as { acpx_record_id?: string; acp_session_id?: string };
      assert.equal(storedRecord.acpx_record_id, recordId);
      assert.equal(storedRecord.acp_session_id, newSessions[1]?.sessionId);
    } finally {
      await runCli([...agentArgs, "sessions", "close"], homeDir).catch(() => undefined);
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: SIGINT flushes buffered one-shot output", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      for (const format of ["quiet", "text"] as const) {
        const marker = `partial-before-${format}-interrupt`;
        const callLog = path.join(homeDir, `interrupt-${format}.ndjson`);
        const agentCommand = `${MOCK_AGENT_COMMAND} --call-log ${JSON.stringify(callLog)} --ignore-sigterm --close-delay-ms 900`;
        const child = spawn(
          process.execPath,
          [
            CLI_PATH,
            "--agent",
            agentCommand,
            "--approve-all",
            "--cwd",
            cwd,
            "--format",
            format,
            "exec",
            `stream-sleep 5000 ${marker}`,
          ],
          {
            env: { ...process.env, HOME: homeDir },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const closePromise = awaitChildClose(child);

        try {
          await waitFor(async () => {
            const calls = await readMockAgentCalls(callLog);
            return calls.some(
              (call) => call.method === "session/update-sent" && call.text === marker,
            )
              ? true
              : null;
          }, 5_000);
          child.kill("SIGINT");

          const result = await Promise.race([
            closePromise,
            sleep(10_000).then(() => {
              throw new Error(`${format} exec did not exit after SIGINT`);
            }),
          ]);
          assert.equal(result.code, 130, `${result.stdout}${result.stderr}`);
          assert.match(result.stdout, new RegExp(marker));
          if (format === "text") {
            assert.match(result.stdout, /\[done\] cancelled/);
          }
        } finally {
          await stopChildProcess(child, 5_000, `${format} interrupted exec`).catch(() => undefined);
        }
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec reports unresolved compaction as incomplete and discards the session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "exec", "compact-no-final"],
        homeDir,
      );
      assert.equal(result.code, 6, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const incomplete = payloads.find((payload) => payload.method === "_acpx/turn_incomplete") as
        | { params?: { reason?: string; stopReason?: string } }
        | undefined;
      assert.deepEqual(incomplete?.params, {
        reason: "context_compaction",
        stopReason: "end_turn",
      });

      const sessionFiles = await fs
        .readdir(path.join(homeDir, ".acpx", "sessions"))
        .catch(() => [] as string[]);
      assert.deepEqual(sessionFiles, []);

      const limited = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "exec", "compact-no-final-max-tokens"],
        homeDir,
      );
      assert.equal(limited.code, 6, limited.stderr);
      const limitedIncomplete = parseJsonRpcOutputLines(limited.stdout).find(
        (payload) => payload.method === "_acpx/turn_incomplete",
      ) as { params?: { reason?: string; stopReason?: string } } | undefined;
      assert.deepEqual(limitedIncomplete?.params, {
        reason: "context_compaction",
        stopReason: "max_tokens",
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: incomplete output stays format-safe and a post-compaction final completes", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const textResult = await runCli(
        [...baseAgentArgs(cwd), "--format", "text", "exec", "compact-no-final"],
        homeDir,
      );
      assert.equal(textResult.code, 6, textResult.stderr);
      assert.match(
        textResult.stdout,
        /\[incomplete\] context_compaction .* explicit follow-up required/,
      );
      assert.doesNotMatch(textResult.stdout, /\[done\]/);

      const quietResult = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "exec", "compact-no-final"],
        homeDir,
      );
      assert.equal(quietResult.code, 6, quietResult.stderr);
      assert.equal(quietResult.stdout.trim(), "");
      assert.match(
        quietResult.stderr,
        /incomplete: context_compaction; no final answer was emitted/,
      );

      const strictResult = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--json-strict", "exec", "compact-no-final"],
        homeDir,
      );
      assert.equal(strictResult.code, 6, strictResult.stderr);
      assert.equal(strictResult.stderr, "");
      const strictPayloads = parseJsonRpcOutputLines(strictResult.stdout);
      assert.equal(
        strictPayloads.some((payload) => payload.method === "_acpx/turn_incomplete"),
        true,
      );

      const finalResult = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "exec", "compact-final"],
        homeDir,
      );
      assert.equal(finalResult.code, 0, finalResult.stderr);
      assert.equal(finalResult.stdout.trim(), "answer after compaction");

      const lateFinalResult = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "exec", "compact-late-final"],
        homeDir,
      );
      assert.equal(lateFinalResult.code, 0, lateFinalResult.stderr);
      assert.equal(lateFinalResult.stdout.trim(), "late answer after compaction");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: persistent prompt keeps the exact session after incomplete compaction", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const callLog = path.join(cwd, "agent-calls.ndjson");
    const agentArgs = [
      "--agent",
      `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --call-log ${JSON.stringify(callLog)}`,
      "--approve-all",
      "--cwd",
      cwd,
    ];

    try {
      const created = await runCli([...agentArgs, "--format", "json", "sessions", "new"], homeDir);
      assert.equal(created.code, 0, created.stderr);

      const incomplete = await runCli(
        [...agentArgs, "--format", "json", "--ttl", "60", "prompt", "compact-no-final"],
        homeDir,
      );
      assert.equal(incomplete.code, 6, incomplete.stderr);
      assert.equal(
        parseJsonRpcOutputLines(incomplete.stdout).some(
          (payload) => payload.method === "_acpx/turn_incomplete",
        ),
        true,
      );

      const durableIncomplete = await readSessionStreamNotifications(
        homeDir,
        "_acpx/turn_incomplete",
      );
      assert.deepEqual(durableIncomplete, [
        { reason: "context_compaction", stopReason: "end_turn" },
      ]);

      const followUp = await runCli(
        [...agentArgs, "--format", "quiet", "prompt", "echo resumed-after-incomplete"],
        homeDir,
      );
      assert.equal(followUp.code, 0, followUp.stderr);
      assert.equal(followUp.stdout.trim(), "resumed-after-incomplete");

      const calls = await readMockAgentCalls(callLog);
      const createdSessionId = calls.find((call) => call.method === "session/new")?.sessionId;
      assert.equal(typeof createdSessionId, "string");
      const promptCalls = calls.filter((call) => call.method === "session/prompt");
      assert.deepEqual(
        promptCalls.map((call) => call.sessionId),
        [createdSessionId, createdSessionId],
      );
      assert.equal(calls.filter((call) => call.method === "session/new").length, 1);
    } finally {
      await runCli([...agentArgs, "--format", "json", "sessions", "close"], homeDir).catch(
        () => undefined,
      );
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: replayed compaction from session load does not taint the next prompt", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const agentArgs = [
      "--agent",
      `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --replay-load-session-compaction`,
      "--approve-all",
      "--cwd",
      cwd,
    ];

    try {
      const created = await runCli([...agentArgs, "--format", "json", "sessions", "new"], homeDir);
      assert.equal(created.code, 0, created.stderr);

      const result = await runCli(
        [...agentArgs, "--format", "json", "--ttl", "60", "prompt", "echo after replay"],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);
      const payloads = parseJsonRpcOutputLines(result.stdout);
      assert.equal(
        payloads.some((payload) => payload.method === "_acpx/turn_incomplete"),
        false,
      );
      assert.equal(
        payloads
          .flatMap((payload) => extractAgentMessageChunkText(payload) ?? [])
          .join("")
          .trim(),
        "after replay",
      );
    } finally {
      await runCli([...agentArgs, "--format", "json", "sessions", "close"], homeDir).catch(
        () => undefined,
      );
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: no-wait prompt records incomplete compaction durably", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const queued = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "--ttl",
          "60",
          "prompt",
          "--no-wait",
          "compact-no-final",
        ],
        homeDir,
      );
      assert.equal(queued.code, 0, queued.stderr);
      assert.equal(
        (JSON.parse(queued.stdout.trim()) as { action?: string }).action,
        "prompt_queued",
      );

      const notification = await waitFor(async () => {
        const found = await readSessionStreamNotifications(homeDir, "_acpx/turn_incomplete");
        return found[0] ?? null;
      }, 5_000);
      assert.deepEqual(notification, {
        reason: "context_compaction",
        stopReason: "end_turn",
      });
    } finally {
      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "close"], homeDir).catch(
        () => undefined,
      );
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: built-in cursor agent resolves to cursor-agent acp", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-cursor-"));

    try {
      await writeFakeCursorAgent(fakeBinDir);

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "cursor", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run --no-fs disables advertised filesystem capabilities", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          ...baseLoadCapableAgentArgs(cwd),
          "--format",
          "json",
          "--no-fs",
          "flow",
          "run",
          FLOW_FIXTURE_PATH,
          "--input-json",
          JSON.stringify({ next: "yes_path" }),
        ],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as { runDir?: string };
      assert.equal(typeof payload.runDir, "string", result.stdout);

      const manifest = JSON.parse(
        await fs.readFile(path.join(payload.runDir ?? "", "manifest.json"), "utf8"),
      ) as { sessions?: Array<{ eventsPath?: string }> };
      const eventsPath = manifest.sessions?.[0]?.eventsPath;
      assert.equal(typeof eventsPath, "string");

      const events = (await fs.readFile(path.join(payload.runDir ?? "", eventsPath ?? ""), "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              message?: {
                method?: string;
                params?: {
                  clientCapabilities?: {
                    fs?: { readTextFile?: unknown; writeTextFile?: unknown };
                  };
                };
              };
            },
        );
      const initializeRequest = events.find((event) => event.message?.method === "initialize");

      assert(initializeRequest, JSON.stringify(events, null, 2));
      assert.deepEqual(initializeRequest.message?.params?.clientCapabilities?.fs, {
        readTextFile: false,
        writeTextFile: false,
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: unrouted incomplete flow exits with code 6", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-incomplete-cwd-"));
    const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-incomplete-definition-"));
    const flowPath = path.join(flowDir, "unrouted-incomplete.flow.ts");

    try {
      await fs.writeFile(
        flowPath,
        [
          'import { acp, defineFlow } from "acpx/flows";',
          "",
          "export default defineFlow({",
          '  name: "unrouted-incomplete",',
          '  startAt: "compacted",',
          "  nodes: {",
          "    compacted: acp({",
          "      session: { isolated: true },",
          '      prompt: () => "compact-no-final",',
          "    }),",
          "  },",
          "  edges: [],",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "flow", "run", flowPath],
        homeDir,
      );
      assert.equal(result.code, 6, result.stderr);
      assert.match(result.stderr, /incomplete: context_compaction/);
      assert.doesNotMatch(result.stderr, /\[acpx\] error:/);

      const strictResult = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--json-strict", "flow", "run", flowPath],
        homeDir,
      );
      assert.equal(strictResult.code, 6, strictResult.stderr);
      assert.equal(strictResult.stderr, "");
      assert.deepEqual(parseJsonRpcOutputLines(strictResult.stdout).at(-1), {
        jsonrpc: "2.0",
        method: "_acpx/turn_incomplete",
        params: {
          reason: "context_compaction",
          stopReason: "end_turn",
        },
      });
    } finally {
      await fs.rm(flowDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: routed incomplete flow stays clean in json-strict mode", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-routed-cwd-"));
    const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-routed-definition-"));
    const flowPath = path.join(flowDir, "routed-incomplete.flow.ts");

    try {
      await fs.writeFile(
        flowPath,
        [
          'import { acp, action, defineFlow } from "acpx/flows";',
          "",
          "export default defineFlow({",
          '  name: "routed-incomplete",',
          '  startAt: "compacted",',
          "  nodes: {",
          "    compacted: acp({",
          "      session: { isolated: true },",
          '      prompt: () => "compact-no-final",',
          "    }),",
          "    handled: action({",
          "      run: ({ results }) => ({ outcome: results.compacted?.outcome }),",
          "    }),",
          "  },",
          "  edges: [{",
          '    from: "compacted",',
          '    switch: { on: "$result.outcome", cases: { incomplete: "handled" } },',
          "  }],",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--json-strict", "flow", "run", flowPath],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      const payload = JSON.parse(result.stdout.trim()) as {
        status?: string;
        outputs?: { handled?: { outcome?: string } };
      };
      assert.equal(payload.status, "completed");
      assert.equal(payload.outputs?.handled?.outcome, "incomplete");
    } finally {
      await fs.rm(flowDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: permission denial takes precedence over unresolved compaction", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-permission-compaction-cwd-"));
    const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-permission-compaction-flow-"));
    const flowPath = path.join(flowDir, "permission-compaction.flow.ts");
    const denyAgentArgs = ["--agent", LOAD_CAPABLE_MOCK_AGENT_COMMAND, "--deny-all", "--cwd", cwd];
    const flowAgentArgs = [
      "--agent",
      LOAD_CAPABLE_MOCK_AGENT_COMMAND,
      "--approve-reads",
      "--cwd",
      cwd,
    ];

    try {
      const quiet = await runCli(
        [...denyAgentArgs, "--format", "quiet", "exec", "permission-denied-compact"],
        homeDir,
      );
      assert.equal(quiet.code, 5, quiet.stderr);
      assert.match(quiet.stderr, /\[acpx\] error: PERMISSION_DENIED/);
      assert.doesNotMatch(quiet.stderr, /\[acpx\] incomplete:/);
      assert.equal(quiet.stdout, "");

      const strict = await runCli(
        [
          ...denyAgentArgs,
          "--format",
          "json",
          "--json-strict",
          "exec",
          "permission-denied-compact",
        ],
        homeDir,
      );
      assert.equal(strict.code, 5, strict.stderr);
      assert.equal(strict.stderr, "");
      assert.equal(
        parseJsonRpcOutputLines(strict.stdout).some(
          (payload) => payload.method === "_acpx/turn_incomplete",
        ),
        false,
      );

      await fs.writeFile(
        flowPath,
        [
          'import { acp, action, defineFlow } from "acpx/flows";',
          "",
          "export default defineFlow({",
          '  name: "permission-before-compaction",',
          '  startAt: "approved",',
          "  nodes: {",
          "    approved: acp({",
          '      session: { handle: "shared" },',
          '      prompt: () => "permission read warmup",',
          "    }),",
          "    compacted: acp({",
          '      session: { handle: "shared" },',
          '      prompt: () => "permission-denied-compact",',
          "    }),",
          "    handled: action({",
          "      run: ({ results }) => ({ outcome: results.compacted?.outcome }),",
          "    }),",
          "  },",
          "  edges: [",
          '    { from: "approved", to: "compacted" },',
          "    {",
          '      from: "compacted",',
          '      switch: { on: "$result.outcome", cases: { failed: "handled" } },',
          "    },",
          "  ],",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const flow = await runCli(
        [...flowAgentArgs, "--format", "json", "flow", "run", flowPath],
        homeDir,
      );
      assert.equal(flow.code, 0, flow.stderr);
      const payload = JSON.parse(flow.stdout.trim()) as {
        status?: string;
        outputs?: { handled?: { outcome?: string } };
      };
      assert.equal(payload.status, "completed");
      assert.equal(payload.outputs?.handled?.outcome, "failed");
    } finally {
      await fs.rm(flowDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: reused client reports permission stats for each turn", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-permission-delta-cwd-"));
    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const { createSessionWithClient, sendSessionDirect } =
        await import("../src/session/session.js");
      const { textPrompt } = await import("../src/prompt-content.js");
      const outputMethods: string[] = [];
      const outputFormatter = {
        setContext: () => {},
        onAcpMessage: (message: object) => {
          const method = "method" in message ? message.method : undefined;
          if (typeof method === "string") {
            outputMethods.push(method);
          }
        },
        onError: () => {},
        onPermissionEscalation: () => {},
        flush: () => {},
      };
      const created = await createSessionWithClient({
        agentCommand: LOAD_CAPABLE_MOCK_AGENT_COMMAND,
        cwd,
        permissionMode: "approve-reads",
        timeoutMs: 10_000,
      });

      try {
        const send = async (message: string, permissionMode: "approve-reads" | "deny-all") =>
          await sendSessionDirect({
            sessionId: created.record.acpxRecordId,
            prompt: textPrompt(message),
            permissionMode,
            outputFormatter,
            timeoutMs: 10_000,
            client: created.client,
          });

        const approved = await send("permission read warmup", "approve-reads");
        assert.deepEqual(approved.permissionStats, {
          requested: 1,
          approved: 1,
          denied: 0,
          cancelled: 0,
        });

        outputMethods.length = 0;
        const denied = await send("permission-denied-compact", "deny-all");
        assert.equal(denied.status, "incomplete");
        assert.deepEqual(denied.permissionStats, {
          requested: 1,
          approved: 0,
          denied: 1,
          cancelled: 0,
        });
        assert.equal(outputMethods.includes("_acpx/turn_incomplete"), false);

        outputMethods.length = 0;
        const incomplete = await send("compact-no-final", "deny-all");
        assert.equal(incomplete.status, "incomplete");
        assert.deepEqual(incomplete.permissionStats, {
          requested: 0,
          approved: 0,
          denied: 0,
          cancelled: 0,
        });
        assert.equal(outputMethods.includes("_acpx/turn_incomplete"), true);
      } finally {
        await created.client.close();
      }
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: SIGINT flushes buffered persistent-session output", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-persistent-interrupt-cwd-"));
    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const { createSessionWithClient, sendSessionDirect } =
        await import("../src/session/session.js");
      const { textPrompt } = await import("../src/prompt-content.js");
      const marker = "persistent-update-before-interrupt";
      let flushCalls = 0;
      let markerObserved = false;
      let interruptSent = false;
      const outputFormatter = {
        setContext: () => {},
        onAcpMessage: () => {},
        onError: () => {},
        onPermissionEscalation: () => {},
        flush: () => {
          flushCalls += 1;
        },
      };
      const created = await createSessionWithClient({
        agentCommand: LOAD_CAPABLE_MOCK_AGENT_COMMAND,
        cwd,
        permissionMode: "approve-all",
        timeoutMs: 10_000,
      });

      try {
        const interrupted = sendSessionDirect({
          sessionId: created.record.acpxRecordId,
          prompt: textPrompt(`stream-sleep 5000 ${marker}`),
          permissionMode: "approve-all",
          outputFormatter,
          timeoutMs: 10_000,
          client: created.client,
          onSessionUpdate: (notification) => {
            const update = notification.update;
            const observedText =
              update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
                ? update.content.text
                : undefined;
            if (observedText !== marker || interruptSent) {
              return;
            }
            markerObserved = true;
            interruptSent = true;
            process.emit("SIGINT");
          },
        });

        await assert.rejects(interrupted, /Interrupted/);
        assert.equal(markerObserved, true);
        assert.equal(flushCalls, 1);
      } finally {
        await created.client.close();
      }
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run executes multiple ACP steps in one session and branches", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          ...baseLoadCapableAgentArgs(cwd),
          "--format",
          "json",
          "--ttl",
          "1",
          "flow",
          "run",
          FLOW_FIXTURE_PATH,
          "--input-json",
          JSON.stringify({ next: "yes_path" }),
        ],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as {
        action?: string;
        status?: string;
        outputs?: Record<string, unknown>;
        sessionBindings?: Record<string, { acpxRecordId: string }>;
      };

      assert.equal(payload.action, "flow_run_result");
      assert.equal(payload.status, "completed");
      assert.deepEqual(payload.outputs?.yes_path, { ok: true });
      assert.equal(payload.outputs?.no_path, undefined);
      assert.equal(
        Object.keys(payload.sessionBindings ?? {}).length,
        1,
        JSON.stringify(payload, null, 2),
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run supports dynamic ACP working directories", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          ...baseLoadCapableAgentArgs(cwd),
          "--format",
          "json",
          "--ttl",
          "1",
          "flow",
          "run",
          FLOW_WORKDIR_FIXTURE_PATH,
        ],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as {
        action?: string;
        status?: string;
        outputs?: {
          prepare?: { workdir: string };
          finalize?: { cwd: string };
        };
        sessionBindings?: Record<string, { cwd: string }>;
      };

      assert.equal(payload.action, "flow_run_result");
      assert.equal(payload.status, "completed");
      const workdir = payload.outputs?.prepare?.workdir;
      const finalCwd = payload.outputs?.finalize?.cwd;
      assert.equal(typeof workdir, "string");
      assert.equal(typeof finalCwd, "string");
      assert.equal(await fs.realpath(String(finalCwd)), await fs.realpath(String(workdir)));
      const bindings = Object.values(payload.sessionBindings ?? {});
      assert.equal(bindings.length, 1);
      assert.equal(await fs.realpath(bindings[0]?.cwd ?? ""), await fs.realpath(String(workdir)));
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run executes function and shell actions from --input-file", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const inputPath = path.join(cwd, "input.json");

    try {
      await fs.writeFile(inputPath, JSON.stringify({ text: "smoke" }), "utf8");

      const result = await runCli(
        [
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "flow",
          "run",
          FLOW_SHELL_FIXTURE_PATH,
          "--input-file",
          inputPath,
        ],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as {
        action?: string;
        status?: string;
        outputs?: {
          prepare?: { text: string };
          finalize?: { value: string; cwd: string };
        };
      };

      assert.equal(payload.action, "flow_run_result");
      assert.equal(payload.status, "completed");
      assert.equal(payload.outputs?.prepare?.text, "SMOKE");
      assert.equal(payload.outputs?.finalize?.value, "SMOKE");
      assert.equal(await fs.realpath(payload.outputs?.finalize?.cwd ?? ""), await fs.realpath(cwd));
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run finalizes interrupted bundles on SIGHUP", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const child = spawn(
        process.execPath,
        [
          CLI_PATH,
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "flow",
          "run",
          FLOW_INTERRUPT_FIXTURE_PATH,
        ],
        {
          env: {
            ...process.env,
            HOME: homeDir,
          },
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      const outputRoot = path.join(homeDir, ".acpx", "flows", "runs");
      const runDir = await waitForFlowRunDir(outputRoot, "fixture-interrupt");
      await waitFor(async () => {
        const state = await readFlowRunJson(runDir);
        if (state.currentNode === "slow" && state.status === "running") {
          return state;
        }
        return null;
      }, 5_000);

      child.kill("SIGHUP");
      const result = await awaitChildClose(child);
      assert.equal(result.code, 130, stderr);

      const finalState = await waitFor(async () => {
        const state = await readFlowRunJson(runDir);
        if (state.status === "failed" && state.error === "Interrupted") {
          return state;
        }
        return null;
      }, 5_000);

      assert.equal(finalState.currentNode, "slow");
      assert.equal(finalState.currentAttemptId, "slow#1");
      const statusDetail =
        typeof finalState.statusDetail === "string" ? finalState.statusDetail : "";
      assert.match(statusDetail, /Failed in slow: Interrupted/);

      const traceEvents = (await fs.readFile(path.join(runDir, "trace.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string; payload?: { error?: string } });
      const finalEvent = traceEvents.at(-1);
      assert.equal(finalEvent?.type, "run_failed");
      assert.equal(finalEvent?.payload?.error, "Interrupted");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run fails ACP nodes promptly when the agent disconnects mid-prompt", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          ...baseLoadCapableAgentArgs(cwd),
          "--format",
          "json",
          "flow",
          "run",
          FLOW_ACP_DISCONNECT_FIXTURE_PATH,
        ],
        homeDir,
        {
          cwd,
          timeoutMs: 5_000,
        },
      );

      const outputRoot = path.join(homeDir, ".acpx", "flows", "runs");
      const runDir = await waitForFlowRunDir(outputRoot, "fixture-acp-disconnect");
      assert.notEqual(result.code, 0, result.stdout);

      const finalState = await waitFor(async () => {
        const state = await readFlowRunJson(runDir).catch(() => null);
        return state && state.status === "failed" ? state : null;
      }, 5_000);

      assert.equal(finalState.status, "failed");
      assert.equal(
        (finalState.results as Record<string, { outcome?: string }>).slow?.outcome,
        "failed",
      );
      assert.match(
        (finalState.results as Record<string, { error?: string }>).slow?.error ?? result.stderr,
        /agent disconnected/i,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run fails fast when a flow requires an explicit approve-all grant", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-permission-cwd-"));
    const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-permission-"));
    const flowPath = path.join(flowDir, "requires-approve-all.flow.ts");

    try {
      await fs.writeFile(
        flowPath,
        [
          'import { compute, defineFlow } from "acpx/flows";',
          "",
          "export default defineFlow({",
          '  name: "requires-explicit-approve-all",',
          "  permissions: {",
          '    requiredMode: "approve-all",',
          "    requireExplicitGrant: true,",
          '    reason: "This flow writes to the repo and needs full ACP permissions.",',
          "  },",
          '  startAt: "done",',
          "  nodes: {",
          "    done: compute({",
          "      run: () => ({ ok: true }),",
          "    }),",
          "  },",
          "  edges: [],",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runCli(
        ["--agent", MOCK_AGENT_COMMAND, "--cwd", cwd, "flow", "run", flowPath],
        homeDir,
      );

      assert.equal(result.code, 2);
      assert.match(result.stderr, /requires an explicit approve-all grant/i);
      assert.match(result.stderr, /Rerun with --approve-all/i);
    } finally {
      await fs.rm(flowDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run requires defineFlow before permission gating", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-permission-cwd-"));
    const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-permission-"));
    const flowPath = path.join(flowDir, "plain-export.flow.ts");

    try {
      await fs.writeFile(
        flowPath,
        [
          "export default {",
          '  name: "plain-export",',
          "  permissions: {",
          '    requiredMode: "approve-all",',
          "    requireExplicitGrant: true,",
          '    reason: "This flow writes to the repo and needs full ACP permissions.",',
          "  },",
          '  startAt: "done",',
          "  nodes: {",
          '    done: { nodeType: "compute", run: () => ({ ok: true }) },',
          "  },",
          "  edges: [],",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runCli(["--cwd", cwd, "flow", "run", flowPath], homeDir);

      assert.equal(result.code, 1);
      assert.match(
        result.stderr,
        /Flow module must export default defineFlow\(\{\.\.\.\}\) from "acpx\/flows"/,
      );
      assert.doesNotMatch(result.stderr, /requires an explicit approve-all grant/i);
      assert.doesNotMatch(result.stderr, /Rerun with --approve-all/i);
    } finally {
      await fs.rm(flowDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run preserves approve-all through persistent ACP writes", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-write-cwd-"));
    const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-write-"));
    const flowPath = path.join(flowDir, "write-through-session.flow.ts");
    const writePath = path.join(cwd, "flow-write.txt");

    try {
      await fs.writeFile(
        flowPath,
        [
          'import { acp, defineFlow } from "acpx/flows";',
          "",
          "export default defineFlow({",
          '  name: "write-through-session",',
          "  permissions: {",
          '    requiredMode: "approve-all",',
          "    requireExplicitGrant: true,",
          '    reason: "This flow writes files through ACP.",',
          "  },",
          '  startAt: "write_file",',
          "  nodes: {",
          "    write_file: acp({",
          `      prompt: () => ${jsStringLiteral(`write ${writePath} hello`)},`,
          "      parse: (text) => ({ reply: text }),",
          "    }),",
          "  },",
          "  edges: [],",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runCli(
        [
          "--agent",
          LOAD_CAPABLE_MOCK_AGENT_COMMAND,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--ttl",
          "1",
          "flow",
          "run",
          flowPath,
        ],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as {
        action?: string;
        status?: string;
        outputs?: {
          write_file?: {
            reply?: string;
          };
        };
      };

      assert.equal(payload.action, "flow_run_result");
      assert.equal(payload.status, "completed");
      assert.match(payload.outputs?.write_file?.reply ?? "", /wrote /i);
      assert.equal(await fs.readFile(writePath, "utf8"), "hello");
    } finally {
      await fs.rm(flowDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run applies permission policy to ACP permission requests", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-policy-cwd-"));
    const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-policy-"));
    const flowPath = path.join(flowDir, "permission-policy.flow.ts");

    try {
      await fs.writeFile(
        flowPath,
        [
          'import { acp, defineFlow } from "acpx/flows";',
          "",
          "export default defineFlow({",
          '  name: "permission-policy-flow",',
          "  permissions: {",
          '    requiredMode: "approve-all",',
          "    requireExplicitGrant: true,",
          '    reason: "This flow intentionally requests a write-like ACP permission.",',
          "  },",
          '  startAt: "permission",',
          "  nodes: {",
          "    permission: acp({",
          '      prompt: () => "permission execute Bash",',
          "      parse: (text) => ({ reply: text }),",
          "    }),",
          "  },",
          "  edges: [],",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runCli(
        [
          "--agent",
          LOAD_CAPABLE_MOCK_AGENT_COMMAND,
          "--approve-all",
          "--policy",
          '{"autoDeny":["execute"]}',
          "--cwd",
          cwd,
          "--format",
          "json",
          "flow",
          "run",
          flowPath,
        ],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as {
        action?: string;
        status?: string;
        outputs?: {
          permission?: {
            reply?: string;
          };
        };
      };

      assert.equal(payload.action, "flow_run_result");
      assert.equal(payload.status, "completed");
      assert.equal(payload.outputs?.permission?.reply, "permission selected:reject");
    } finally {
      await fs.rm(flowDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

function jsStringLiteral(value: string): string {
  return escapeUnsafeCodeChars(JSON.stringify(value));
}

function escapeUnsafeCodeChars(value: string): string {
  return value.replace(
    /[<>\u2028\u2029]/g,
    (char) => unsafeCodeCharEscapes[char as keyof typeof unsafeCodeCharEscapes],
  );
}

test('integration: flow run resolves "acpx/flows" imports for external flow files', async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-import-"));
    const flowPath = path.join(flowDir, "external.flow.ts");

    try {
      await fs.writeFile(
        flowPath,
        [
          'import { compute, defineFlow } from "acpx/flows";',
          "",
          "export default defineFlow({",
          '  name: "external-flow-import",',
          '  startAt: "done",',
          "  nodes: {",
          "    done: compute({",
          '      run: () => ({ ok: true, source: "external" }),',
          "    }),",
          "  },",
          "  edges: [],",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "json", "flow", "run", flowPath],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as {
        action?: string;
        status?: string;
        outputs?: {
          done?: {
            ok?: boolean;
            source?: string;
          };
        };
      };

      assert.equal(payload.action, "flow_run_result");
      assert.equal(payload.status, "completed");
      assert.deepEqual(payload.outputs?.done, {
        ok: true,
        source: "external",
      });
    } finally {
      await fs.rm(flowDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run supports staged defineFlow assembly in external modules", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-flow-staged-"));
    const flowPath = path.join(flowDir, "staged.flow.ts");

    try {
      await fs.writeFile(
        flowPath,
        [
          'import { compute, defineFlow } from "acpx/flows";',
          "",
          "const nodes = {};",
          "const flow = defineFlow({",
          '  name: "staged-flow-import",',
          '  startAt: "done",',
          "  nodes,",
          "  edges: [],",
          "});",
          "",
          "nodes.done = compute({",
          '  run: () => ({ ok: true, source: "staged" }),',
          "});",
          "",
          "export default flow;",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "json", "flow", "run", flowPath],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as {
        action?: string;
        status?: string;
        outputs?: {
          done?: {
            ok?: boolean;
            source?: string;
          };
        };
      };

      assert.equal(payload.action, "flow_run_result");
      assert.equal(payload.status, "completed");
      assert.deepEqual(payload.outputs?.done, {
        ok: true,
        source: "staged",
      });
    } finally {
      await fs.rm(flowDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: flow run reports waiting checkpoints in json mode", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "flow",
          "run",
          FLOW_WAIT_FIXTURE_PATH,
          "--input-json",
          JSON.stringify({ ticket: "pr-174" }),
        ],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as {
        action?: string;
        status?: string;
        waitingOn?: string;
        outputs?: {
          prepare?: { ticket: string };
          wait_for_human?: { checkpoint: string; summary: string };
          unreachable?: unknown;
        };
      };

      assert.equal(payload.action, "flow_run_result");
      assert.equal(payload.status, "waiting");
      assert.equal(payload.waitingOn, "wait_for_human");
      assert.equal(payload.outputs?.prepare?.ticket, "pr-174");
      assert.equal(payload.outputs?.wait_for_human?.checkpoint, "wait_for_human");
      assert.equal(payload.outputs?.wait_for_human?.summary, "review pr-174");
      assert.equal(payload.outputs?.unreachable, undefined);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: built-in droid agent resolves to droid exec --output-format acp", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-droid-"));

    try {
      await writeFakeDroidAgent(fakeBinDir);

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "droid", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: factory-droid alias resolves to droid exec --output-format acp", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-droid-"));

    try {
      await writeFakeDroidAgent(fakeBinDir);

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "factory-droid", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: built-in fast-agent resolves to uvx fast-agent-mcp acp", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-fast-agent-"));

    try {
      await writeFakeUvxFastAgentAcp(fakeBinDir);

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "fast-agent", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: built-in grok-build agent resolves to grok agent stdio", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-grok-build-"));

    try {
      await writeFakeGrokBuildAgent(fakeBinDir);

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "grok-build", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: built-in pool agent resolves to pool acp", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-pool-"));

    try {
      await writeFakePoolAgent(fakeBinDir);

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "pool", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: built-in zeroclaw agent resolves to zeroclaw acp", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-zeroclaw-"));

    try {
      await writeFakeZeroClawAgent(fakeBinDir);

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "zeroclaw", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: built-in iflow agent resolves to iflow --experimental-acp", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-iflow-"));

    try {
      await writeFakeIflowAgent(fakeBinDir);

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "iflow", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: built-in qoder agent resolves to qodercli --acp", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-qoder-"));

    try {
      await writeFakeQoderAgent(fakeBinDir);

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "qoder", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: qoder session reuse preserves persisted startup flags", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-qoder-"));
    const argLogPath = path.join(fakeBinDir, "qoder-args.log");

    try {
      await writeFakeQoderAgent(fakeBinDir, argLogPath);
      const { createSession } = await import("../src/session/session.js");
      const { runSessionSetModeDirect } = await import("../src/cli/session/prompt-runner.js");
      const previousHome = process.env.HOME;
      const previousPath = process.env.PATH;
      process.env.HOME = homeDir;
      process.env.PATH = `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`;

      try {
        const record = await createSession({
          agentCommand: "qodercli --acp",
          cwd,
          permissionMode: "approve-reads",
          timeoutMs: 10_000,
          sessionOptions: {
            allowedTools: ["Read", "Grep"],
            maxTurns: 4,
          },
        });

        const result = await runSessionSetModeDirect({
          sessionRecordId: record.acpxRecordId,
          modeId: "plan",
          timeoutMs: 10_000,
        });
        assert.equal(result.record.acpxRecordId, record.acpxRecordId);
      } finally {
        if (previousHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = previousHome;
        }
        process.env.PATH = previousPath;
      }

      const argLines = (await fs.readFile(argLogPath, "utf8"))
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      assert.equal(
        argLines.length >= 2,
        true,
        `expected at least two qoder invocations:\n${argLines.join("\n")}`,
      );
      assert.equal(
        argLines.some(
          (line) =>
            line.includes("--acp") &&
            line.includes("--max-turns=4") &&
            line.includes("--allowed-tools=READ,GREP"),
        ),
        true,
        `expected persisted qoder flags in logged invocations:\n${argLines.join("\n")}`,
      );
      assert.equal(
        argLines.slice(-1)[0]?.includes("--allowed-tools=READ,GREP") ?? false,
        true,
        `expected reused prompt spawn to preserve allowed-tools:\n${argLines.join("\n")}`,
      );
      assert.equal(
        argLines.slice(-1)[0]?.includes("--max-turns=4") ?? false,
        true,
        `expected reused prompt spawn to preserve max-turns:\n${argLines.join("\n")}`,
      );
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec forwards model, allowed-tools, and max-turns in session/new _meta", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const claudeCompatibleAgentCommand = `${MOCK_AGENT_COMMAND} --claude-agent-acp`;

    try {
      const created = await runCli(
        ["--agent", claudeCompatibleAgentCommand, "--approve-all", "--cwd", cwd, "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const result = await runCli(
        [
          "--agent",
          claudeCompatibleAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--model",
          "sonnet",
          "--allowed-tools",
          "Read,Grep",
          "--max-turns",
          "7",
          "exec",
          "echo hello",
        ],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const createRequest = payloads.find((payload) => payload.method === "session/new") as
        | { params?: { _meta?: unknown } }
        | undefined;
      assert(createRequest, result.stdout);
      assert.deepEqual(createRequest.params?._meta, {
        claudeCode: {
          options: {
            model: "sonnet",
            allowedTools: ["Read", "Grep"],
            maxTurns: 7,
            settingSources: ["project", "local"],
          },
        },
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec --no-terminal disables advertised terminal capability", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--no-terminal", "exec", "echo hello"],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const initializeRequest = payloads.find((payload) => payload.method === "initialize") as
        | { params?: { clientCapabilities?: { terminal?: unknown } } }
        | undefined;
      assert(initializeRequest, result.stdout);
      assert.equal(initializeRequest.params?.clientCapabilities?.terminal, false);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec --no-fs disables advertised filesystem capabilities", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--no-fs", "exec", "echo hello"],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const initializeRequest = payloads.find((payload) => payload.method === "initialize") as
        | {
            params?: {
              clientCapabilities?: {
                fs?: { readTextFile?: unknown; writeTextFile?: unknown };
              };
            };
          }
        | undefined;
      assert(initializeRequest, result.stdout);
      assert.deepEqual(initializeRequest.params?.clientCapabilities?.fs, {
        readTextFile: false,
        writeTextFile: false,
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: non-Devin ACP launch advertises standard acpx client capabilities", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "exec", "echo hello"],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const initializeRequest = payloads.find((payload) => payload.method === "initialize") as
        | {
            params?: {
              clientCapabilities?: {
                _meta?: unknown;
                elicitation?: unknown;
                fs?: { readTextFile?: unknown; writeTextFile?: unknown };
                terminal?: unknown;
              };
              clientInfo?: { name?: unknown; version?: unknown };
            };
          }
        | undefined;
      assert(initializeRequest, result.stdout);
      assert.equal(initializeRequest.params?.clientInfo?.name, "acpx");
      assert.equal(initializeRequest.params?.clientCapabilities?.terminal, true);
      assert.deepEqual(initializeRequest.params?.clientCapabilities?.fs, {
        readTextFile: true,
        writeTextFile: true,
      });
      assert.equal(initializeRequest.params?.clientCapabilities?._meta, undefined);
      assert.equal(initializeRequest.params?.clientCapabilities?.elicitation, undefined);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec accepts agent extension notifications", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "quiet",
          "exec",
          "extension-notification _cognition.ai/output hello",
        ],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /extension notification accepted: _cognition\.ai\/output/);
      assert.doesNotMatch(result.stderr, /Method not found/);
      assert.doesNotMatch(result.stderr, /Error handling notification/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: non-Devin ACP launch rejects Devin diagnostics extension requests", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "quiet",
          "exec",
          "extension-request _cognition.ai/request_diagnostics hello",
        ],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(
        result.stdout,
        /extension request accepted: _cognition\.ai\/request_diagnostics/,
      );
      assert.match(result.stdout, /^error:/i);
      assert.equal(result.stderr, "");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec answers Devin diagnostics extension requests", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-devin-"));

    try {
      await writeFakeDevinAgent(fakeBinDir);

      const result = await runCli(
        [
          "--agent",
          "devin --model swe-1-6 acp",
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "quiet",
          "exec",
          "extension-request _cognition.ai/request_diagnostics hello",
        ],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(
        result.stdout,
        /extension request accepted: _cognition\.ai\/request_diagnostics \{\}/,
      );
      assert.doesNotMatch(result.stderr, /Method not found/);
      assert.doesNotMatch(result.stderr, /Error handling request/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: Devin ACP launch advertises scoped Windsurf client info", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-devin-"));

    try {
      await writeFakeDevinAgent(fakeBinDir);

      const result = await runCli(
        [
          "--agent",
          "devin --model swe-1-6 --acp",
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "exec",
          "echo hello",
        ],
        homeDir,
        {
          env: {
            ACPX_DEVIN_WINDSURF_VERSION: "9.9.9-test",
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const initializeRequest = payloads.find((payload) => payload.method === "initialize") as
        | {
            params?: {
              clientCapabilities?: {
                _meta?: Record<string, unknown> | null;
                elicitation?: unknown;
                fs?: { readTextFile?: unknown; writeTextFile?: unknown };
                terminal?: unknown;
              };
              clientInfo?: {
                name?: unknown;
                version?: unknown;
              };
            };
          }
        | undefined;
      assert(initializeRequest, result.stdout);
      assert.deepEqual(initializeRequest.params?.clientInfo, {
        name: "windsurf",
        version: "9.9.9-test",
      });
      assert.equal(initializeRequest.params?.clientCapabilities?.terminal, true);
      assert.deepEqual(initializeRequest.params?.clientCapabilities?.fs, {
        readTextFile: true,
        writeTextFile: true,
      });
      assert.deepEqual(initializeRequest.params?.clientCapabilities?._meta, {
        "cognition.ai/requestDiagnostics": true,
      });
      assert.equal(initializeRequest.params?.clientCapabilities?.elicitation, undefined);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec --model sets the advertised model config option", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const modelAgentCommand = `${MOCK_AGENT_COMMAND} --advertise-models`;

    try {
      const result = await runCli(
        [
          "--agent",
          modelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--model",
          "fast-model",
          "exec",
          "echo hello",
        ],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const setModelRequest = payloads.find(
        (payload) =>
          payload.method === "session/set_config_option" &&
          (payload.params as { configId?: unknown } | undefined)?.configId === "model",
      ) as { params?: { configId?: string; value?: string } } | undefined;
      assert(setModelRequest, "expected model session config request in JSON-RPC output");
      assert.equal(setModelRequest.params?.value, "fast-model");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec applies model before model-specific effort", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const agentCommand = `${MOCK_AGENT_COMMAND} --model-dependent-efforts`;

    try {
      const result = await runCli(
        [
          "--agent",
          agentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--model",
          "smart-model",
          "--effort",
          "xhigh",
          "exec",
          "echo hello",
        ],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const requests = payloads.filter(
        (payload) =>
          payload.method === "session/set_config_option" || payload.method === "session/prompt",
      );
      assert.deepEqual(
        requests.map((request) => ({
          method: request.method,
          configId: (request.params as { configId?: unknown } | undefined)?.configId,
          value: (request.params as { value?: unknown } | undefined)?.value,
        })),
        [
          { method: "session/set_config_option", configId: "model", value: "smart-model" },
          {
            method: "session/set_config_option",
            configId: "reasoning_effort",
            value: "xhigh",
          },
          { method: "session/prompt", configId: undefined, value: undefined },
        ],
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec rejects effort unavailable for the selected model before prompting", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const agentCommand = `${MOCK_AGENT_COMMAND} --model-dependent-efforts`;

    try {
      const result = await runCli(
        [
          "--agent",
          agentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--model",
          "smart-model",
          "--effort",
          "medium",
          "exec",
          "echo should-not-run",
        ],
        homeDir,
      );
      assert.notEqual(result.code, 0, "expected non-zero exit");
      const payloads = parseJsonRpcOutputLines(result.stdout);
      const errorMessage = (
        payloads.find((payload) => payload.error) as { error?: { message?: string } } | undefined
      )?.error?.message;
      assert.match(errorMessage ?? "", /model "smart-model"/);
      assert.match(errorMessage ?? "", /Available efforts: high, xhigh/);
      assert.equal(
        payloads.some((payload) => payload.method === "session/prompt"),
        false,
        "prompt must not run after effort validation fails",
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec --effort fails when the agent advertises no effort control", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--effort", "high", "exec", "echo no"],
        homeDir,
      );
      assert.notEqual(result.code, 0, "expected non-zero exit");
      assert.match(`${result.stderr}\n${result.stdout}`, /did not advertise a thought-level/);
      const payloads = parseJsonRpcOutputLines(result.stdout);
      assert.equal(
        payloads.some((payload) => payload.method === "session/prompt"),
        false,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: persistent sessions retain effort when later prompts omit the flag", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const agentCommand = `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --advertise-config-options`;

    try {
      const created = await runCli(
        [
          "--agent",
          agentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--effort",
          "high",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const prompted = await runCli(
        [
          "--agent",
          agentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "prompt",
          "echo retained",
        ],
        homeDir,
      );
      assert.equal(prompted.code, 0, prompted.stderr);
      const payloads = parseJsonRpcOutputLines(prompted.stdout);
      const effortIndex = payloads.findIndex(
        (payload) =>
          payload.method === "session/set_config_option" &&
          (payload.params as { configId?: unknown } | undefined)?.configId === "reasoning_effort",
      );
      const promptIndex = payloads.findIndex((payload) => payload.method === "session/prompt");
      assert(effortIndex >= 0, "expected saved effort to be re-applied");
      assert(promptIndex > effortIndex, "saved effort must be applied before the prompt");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: sparse reconnect metadata does not erase saved effort", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const agentCommand = `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --advertise-config-options --omit-reconnect-config-options`;

    try {
      const created = await runCli(
        [
          "--agent",
          agentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--effort",
          "high",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const sessionId = (JSON.parse(created.stdout.trim()) as { acpxRecordId: string })
        .acpxRecordId;

      const prompted = await runCli(
        [
          "--agent",
          agentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "prompt",
          "echo sparse",
        ],
        homeDir,
      );
      assert.equal(prompted.code, 0, prompted.stderr);
      const payloads = parseJsonRpcOutputLines(prompted.stdout);
      const effortIndex = payloads.findIndex(
        (payload) =>
          payload.method === "session/set_config_option" &&
          (payload.params as { configId?: unknown } | undefined)?.configId === "reasoning_effort",
      );
      const promptIndex = payloads.findIndex((payload) => payload.method === "session/prompt");
      assert(effortIndex >= 0, "expected saved effort to be forced onto sparse reconnect");
      assert(promptIndex > effortIndex, "saved effort must be applied before the prompt");

      const acpxState = await readStoredSessionAcpxState(homeDir, sessionId);
      assert.deepEqual(acpxState.session_options, { effort: "high" });
      assert.equal(
        (acpxState.desired_config_options as Record<string, unknown> | undefined)?.reasoning_effort,
        "high",
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: set model clears a saved effort unsupported by the new model", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const agentCommand = `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --model-dependent-efforts`;

    try {
      const created = await runCli(
        [
          "--agent",
          agentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--model",
          "smart-model",
          "--effort",
          "xhigh",
          "--format",
          "json",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const sessionId = (JSON.parse(created.stdout.trim()) as { acpxRecordId: string })
        .acpxRecordId;

      const changed = await runCli(
        ["--agent", agentCommand, "--approve-all", "--cwd", cwd, "set", "model", "fast-model"],
        homeDir,
      );
      assert.equal(changed.code, 0, changed.stderr);

      const acpxState = await readStoredSessionAcpxState(homeDir, sessionId);
      assert.deepEqual(acpxState.session_options, { model: "fast-model" });
      assert.equal(
        (acpxState.desired_config_options as Record<string, unknown> | undefined)?.reasoning_effort,
        undefined,
      );

      const prompted = await runCli(
        ["--agent", agentCommand, "--approve-all", "--cwd", cwd, "prompt", "echo changed"],
        homeDir,
      );
      assert.equal(prompted.code, 0, prompted.stderr);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt model switch reconciles saved effort unless --effort is explicit", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const agentCommand = `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --model-dependent-efforts`;

    try {
      const created = await runCli(
        [
          "--agent",
          agentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--model",
          "smart-model",
          "--effort",
          "xhigh",
          "--format",
          "json",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const sessionId = (JSON.parse(created.stdout.trim()) as { acpxRecordId: string })
        .acpxRecordId;

      const prompted = await runCli(
        [
          "--agent",
          agentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--model",
          "fast-model",
          "prompt",
          "echo model-only",
        ],
        homeDir,
      );
      assert.equal(prompted.code, 0, prompted.stderr);

      const acpxState = await readStoredSessionAcpxState(homeDir, sessionId);
      assert.deepEqual(acpxState.session_options, { model: "fast-model" });
      assert.equal(acpxState.current_model_id, "fast-model");
      assert.equal(
        (acpxState.desired_config_options as Record<string, unknown> | undefined)?.reasoning_effort,
        undefined,
      );
    } finally {
      await runCli(
        ["--agent", agentCommand, "--approve-all", "--cwd", cwd, "sessions", "close"],
        homeDir,
      ).catch(() => {});
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt model switch migrates effort keyed by the prior config id", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const agentCommand = `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --model-dependent-efforts`;
    const args = ["--agent", agentCommand, "--approve-all", "--cwd", cwd, "--ttl", "0"];

    try {
      const created = await runCli(
        [
          ...args,
          "--model",
          "default-model",
          "--effort",
          "medium",
          "--format",
          "json",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const sessionId = (JSON.parse(created.stdout.trim()) as { acpxRecordId: string })
        .acpxRecordId;

      const warmed = await runCli([...args, "prompt", "echo warm"], homeDir);
      assert.equal(warmed.code, 0, warmed.stderr);

      const recordPath = sessionRecordPath(homeDir, sessionId);
      const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
        acpx?: {
          session_options?: Record<string, unknown>;
          desired_config_options?: Record<string, unknown>;
          config_options?: Array<Record<string, unknown>>;
        };
      };
      assert(record.acpx);
      const sessionOptions = { ...record.acpx.session_options };
      delete sessionOptions.effort;
      record.acpx.session_options = sessionOptions;
      record.acpx.desired_config_options = { legacy_effort: "medium" };
      record.acpx.config_options = record.acpx.config_options?.map((option) =>
        option.id === "reasoning_effort" ? { ...option, id: "legacy_effort" } : option,
      );
      await fs.writeFile(recordPath, `${JSON.stringify(record)}\n`, "utf8");

      const prompted = await runCli(
        [...args, "--model", "fast-model", "prompt", "echo model-only"],
        homeDir,
      );
      assert.equal(prompted.code, 0, prompted.stderr);

      const acpxState = await readStoredSessionAcpxState(homeDir, sessionId);
      assert.deepEqual(acpxState.session_options, {
        model: "fast-model",
        effort: "medium",
      });
      assert.deepEqual(acpxState.desired_config_options, {
        reasoning_effort: "medium",
      });
    } finally {
      await runCli([...args, "sessions", "close"], homeDir).catch(() => {});
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: sessions ensure applies model and effort through a warm owner", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const callLog = path.join(cwd, "effort-owner-calls.ndjson");
    const agentCommand = `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --model-dependent-efforts --call-log ${JSON.stringify(callLog)}`;
    const args = ["--agent", agentCommand, "--approve-all", "--cwd", cwd];

    try {
      const created = await runCli([...args, "sessions", "new"], homeDir);
      assert.equal(created.code, 0, created.stderr);

      const warmed = await runCli([...args, "--ttl", "0", "prompt", "echo warm"], homeDir);
      assert.equal(warmed.code, 0, warmed.stderr);
      const warmCalls = await readMockAgentCalls(callLog);
      const warmPrompt = warmCalls.findLast((call) => call.method === "session/prompt");
      const { pid: ownerPid } = await readQueueOwnerLock(homeDir, warmPrompt?.sessionId ?? "");
      assert.equal(
        warmPrompt?.parentPid,
        ownerPid,
        "expected the prompt agent to belong to the owner",
      );

      const ensured = await runCli(
        [...args, "--model", "smart-model", "--effort", "xhigh", "sessions", "ensure"],
        homeDir,
      );
      assert.equal(ensured.code, 0, ensured.stderr);

      const calls = await readMockAgentCalls(callLog);
      const preferenceCalls = calls.filter(
        (call) =>
          call.parentPid === ownerPid &&
          call.method === "session/set_config_option" &&
          (call.configId === "model" || call.configId === "reasoning_effort"),
      );
      assert.deepEqual(
        preferenceCalls.slice(-2).map((call) => [call.configId, call.value]),
        [
          ["model", "smart-model"],
          ["reasoning_effort", "xhigh"],
        ],
      );

      const prompted = await runCli([...args, "prompt", "echo configured"], homeDir);
      assert.equal(prompted.code, 0, prompted.stderr);
      const configuredPrompt = (await readMockAgentCalls(callLog)).findLast(
        (call) => call.method === "session/prompt" && call.text === "echo configured",
      );
      assert.equal(configuredPrompt?.parentPid, ownerPid);
      assert.notEqual(configuredPrompt?.pid, warmPrompt?.pid);
      assert.equal(configuredPrompt?.modelId, "smart-model");
      assert.equal(configuredPrompt?.effort, "xhigh");

      const setEffort = await runCli([...args, "set", "reasoning_effort", "high"], homeDir);
      assert.equal(setEffort.code, 0, setEffort.stderr);

      const directEffortPromptResult = await runCli(
        [...args, "prompt", "echo direct-effort"],
        homeDir,
      );
      assert.equal(directEffortPromptResult.code, 0, directEffortPromptResult.stderr);
      const directEffortPrompt = (await readMockAgentCalls(callLog)).findLast(
        (call) => call.method === "session/prompt" && call.text === "echo direct-effort",
      );
      assert.equal(directEffortPrompt?.parentPid, ownerPid);
      assert.notEqual(directEffortPrompt?.pid, configuredPrompt?.pid);
      assert.equal(directEffortPrompt?.modelId, "smart-model");
      assert.equal(directEffortPrompt?.effort, "high");

      const rejected = await runCli(
        [...args, "--model", "fast-model", "--effort", "xhigh", "sessions", "ensure"],
        homeDir,
      );
      assert.notEqual(rejected.code, 0);
      const rejectedState = await readStoredSessionAcpxState(homeDir, warmPrompt?.sessionId ?? "");
      assert.deepEqual(rejectedState.session_options, { model: "fast-model" });
      assert.equal(rejectedState.current_model_id, "fast-model");
      assert.equal(
        (rejectedState.desired_config_options as Record<string, unknown> | undefined)
          ?.reasoning_effort,
        undefined,
      );

      const afterRejected = await runCli([...args, "prompt", "echo after-rejected"], homeDir);
      assert.equal(afterRejected.code, 0, afterRejected.stderr);
      const afterRejectedPrompt = (await readMockAgentCalls(callLog)).findLast(
        (call) => call.method === "session/prompt" && call.text === "echo after-rejected",
      );
      assert.equal(afterRejectedPrompt?.parentPid, ownerPid);
      assert.notEqual(afterRejectedPrompt?.pid, directEffortPrompt?.pid);
      assert.equal(afterRejectedPrompt?.modelId, "fast-model");
      assert.equal(afterRejectedPrompt?.effort, "medium");
    } finally {
      await runCli([...args, "sessions", "close"], homeDir).catch(() => {});
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: failed prompt effort persists an already-applied model change", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const callLog = path.join(cwd, "effort-failure-calls.ndjson");
    const agentCommand = `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --model-dependent-efforts --call-log ${JSON.stringify(callLog)}`;
    const args = ["--agent", agentCommand, "--approve-all", "--cwd", cwd, "--format", "json"];

    try {
      const created = await runCli([...args, "sessions", "new"], homeDir);
      assert.equal(created.code, 0, created.stderr);
      const sessionId = (JSON.parse(created.stdout.trim()) as { acpxRecordId: string })
        .acpxRecordId;

      const rejected = await runCli(
        [...args, "--model", "smart-model", "--effort", "low", "prompt", "echo never"],
        homeDir,
      );
      assert.notEqual(rejected.code, 0);

      const rejectedState = await readStoredSessionAcpxState(homeDir, sessionId);
      assert.deepEqual(rejectedState.session_options, { model: "smart-model" });
      assert.equal(rejectedState.current_model_id, "smart-model");
      assert.equal(
        (rejectedState.desired_config_options as Record<string, unknown> | undefined)
          ?.reasoning_effort,
        undefined,
      );
      const calls = await readMockAgentCalls(callLog);
      assert.equal(
        calls.some((call) => call.method === "session/prompt" && call.text === "echo never"),
        false,
      );
    } finally {
      await runCli([...args, "sessions", "close"], homeDir).catch(() => {});
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec --model fails when agent does not advertise models", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--model", "sonnet", "exec", "echo hello"],
        homeDir,
      );
      assert.notEqual(result.code, 0, "expected non-zero exit");
      assert.match(`${result.stderr}\n${result.stdout}`, /did not advertise model support/);

      const payloads = parseJsonRpcOutputLines(result.stdout);

      const createRequest = payloads.find((payload) => payload.method === "session/new") as
        | { params?: { _meta?: Record<string, unknown> } }
        | undefined;
      assert(createRequest, "expected session/new request");
      assert.deepEqual((createRequest.params?._meta as Record<string, unknown>)?.claudeCode, {
        options: { model: "sonnet" },
      });

      const setModelRequest = payloads.find(
        (payload) =>
          payload.method === "session/set_config_option" &&
          (payload.params as { configId?: unknown } | undefined)?.configId === "model",
      );
      assert.equal(setModelRequest, undefined, "model session config should not be changed");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec --model rejects models not advertised by the agent", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const modelAgentCommand = `${MOCK_AGENT_COMMAND} --advertise-models`;

    try {
      const result = await runCli(
        [
          "--agent",
          modelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--model",
          "missing-model",
          "exec",
          "echo hello",
        ],
        homeDir,
      );
      assert.notEqual(result.code, 0, "expected non-zero exit");
      assert.match(`${result.stderr}\n${result.stdout}`, /did not advertise that model/);
      assert.match(`${result.stderr}\n${result.stdout}`, /default-model, fast-model, smart-model/);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const setModelRequest = payloads.find(
        (payload) =>
          payload.method === "session/set_config_option" &&
          (payload.params as { configId?: unknown } | undefined)?.configId === "model",
      );
      assert.equal(setModelRequest, undefined, "model session config should not be changed");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: Claude ACP prompt forwards saved model missing from reconnect advertisement", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-claude-"));

    try {
      const fakeClaude = await writeFakeClaudeAgent(fakeBinDir);
      const modelAgentCommand = `${JSON.stringify(fakeClaude)} --supports-load-session --advertise-models --omit-reconnect-model gpt-5.4`;
      const created = await runCli(
        [
          "--agent",
          modelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--model",
          "gpt-5.4",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const result = await runCli(
        [
          "--agent",
          modelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--model",
          "gpt-5.4",
          "prompt",
          "echo hello",
        ],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const setModelRequest = payloads.find(
        (payload) =>
          payload.method === "session/set_config_option" &&
          (payload.params as { configId?: unknown } | undefined)?.configId === "model",
      ) as { params?: { configId?: string; value?: string } } | undefined;
      assert(setModelRequest, "expected model session config despite stale advertisement");
      assert.equal(setModelRequest.params?.value, "gpt-5.4");
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt --model updates existing session model before prompt", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const modelAgentCommand = `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --model-config-id llm --omit-reconnect-config-options`;

    try {
      const created = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const result = await runCli(
        [
          "--agent",
          modelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--model",
          "fast-model",
          "prompt",
          "echo hello",
        ],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const setModelRequest = payloads.find(
        (payload) =>
          payload.method === "session/set_config_option" &&
          (payload.params as { configId?: unknown } | undefined)?.configId === "llm",
      ) as { params?: { configId?: string; value?: string } } | undefined;
      assert(setModelRequest, "expected model session config before the persistent prompt");
      assert.equal(setModelRequest.params?.configId, "llm");
      assert.equal(setModelRequest.params?.value, "fast-model");

      const status = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "--format", "json", "status"],
        homeDir,
      );
      assert.equal(status.code, 0, status.stderr);
      assert.equal((JSON.parse(status.stdout.trim()) as { model?: string }).model, "fast-model");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: status preserves model actually reported after set model", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const modelAgentCommand = `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --advertise-models --report-model-as fast-model`;

    try {
      const created = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const setResult = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "set", "model", "gpt-5.4"],
        homeDir,
      );
      assert.equal(setResult.code, 0, setResult.stderr);

      const status = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "--format", "json", "status"],
        homeDir,
      );
      assert.equal(status.code, 0, status.stderr);
      assert.equal((JSON.parse(status.stdout.trim()) as { model?: string }).model, "fast-model");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec --model fails when the model config update fails", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const failModelAgentCommand = `${MOCK_AGENT_COMMAND} --set-session-model-fails`;

    try {
      const result = await runCli(
        [
          "--agent",
          failModelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "quiet",
          "--model",
          "fast-model",
          "exec",
          "echo hello",
        ],
        homeDir,
      );
      assert.notEqual(result.code, 0, "expected non-zero exit");
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /setSessionModel failed|session\/set_config_option/i);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: sessions new --model fails when the model config update fails", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const failModelAgentCommand = `${MOCK_AGENT_COMMAND} --set-session-model-fails`;

    try {
      const result = await runCli(
        [
          "--agent",
          failModelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--model",
          "fast-model",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.notEqual(result.code, 0, "expected non-zero exit");
      assert.match(result.stderr, /setSessionModel failed|session\/set_config_option/i);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: set model routes through the advertised config option and succeeds", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const modelAgentCommand = `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --advertise-models`;

    try {
      // Create session
      const created = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      // Switch model mid-session through the advertised model config option.
      const setResult = await runCli(
        [
          "--agent",
          modelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "set",
          "model",
          "gpt-5.4",
        ],
        homeDir,
      );
      assert.equal(setResult.code, 0, setResult.stderr);
      const payload = JSON.parse(setResult.stdout.trim()) as {
        action?: string;
        modelId?: string;
      };
      assert.equal(payload.action, "model_set");
      assert.equal(payload.modelId, "gpt-5.4");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: legacy model metadata preserves session/set_model compatibility", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const modelAgentCommand = `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --advertise-legacy-models`;

    try {
      const created = await runCli(
        [
          "--agent",
          modelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--model",
          "alternate-model",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const status = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "--format", "json", "status"],
        homeDir,
      );
      assert.equal(status.code, 0, status.stderr);
      assert.equal(
        (JSON.parse(status.stdout.trim()) as { model?: string }).model,
        "alternate-model",
      );

      const setResult = await runCli(
        [
          "--agent",
          modelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "set",
          "model",
          "default-model",
        ],
        homeDir,
      );
      assert.equal(setResult.code, 0, setResult.stderr);
      assert.equal(
        (JSON.parse(setResult.stdout.trim()) as { modelId?: string }).modelId,
        "default-model",
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: legacy model changes clear effort saved for the previous model", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const agentCommand = `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --advertise-legacy-models --advertise-config-options --omit-model-config-option`;

    try {
      const created = await runCli(
        [
          "--agent",
          agentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--effort",
          "high",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const sessionId = (JSON.parse(created.stdout.trim()) as { acpxRecordId: string })
        .acpxRecordId;

      const setModel = await runCli(
        ["--agent", agentCommand, "--approve-all", "--cwd", cwd, "set", "model", "alternate-model"],
        homeDir,
      );
      assert.equal(setModel.code, 0, setModel.stderr);

      const acpxState = await readStoredSessionAcpxState(homeDir, sessionId);
      assert.deepEqual(acpxState.session_options, { model: "alternate-model" });
      assert.equal(
        (acpxState.desired_config_options as Record<string, unknown> | undefined)?.reasoning_effort,
        undefined,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt-time legacy model changes do not resurrect cleared effort", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const agentCommand = `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --advertise-legacy-models --advertise-config-options --omit-model-config-option`;

    try {
      const created = await runCli(
        [
          "--agent",
          agentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--effort",
          "high",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const sessionId = (JSON.parse(created.stdout.trim()) as { acpxRecordId: string })
        .acpxRecordId;

      const prompted = await runCli(
        [
          "--agent",
          agentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--model",
          "alternate-model",
          "prompt",
          "echo legacy switch",
        ],
        homeDir,
      );
      assert.equal(prompted.code, 0, prompted.stderr);

      const payloads = parseJsonRpcOutputLines(prompted.stdout);
      const modelIndex = payloads.findIndex((payload) => payload.method === "session/set_model");
      const promptIndex = payloads.findIndex((payload) => payload.method === "session/prompt");
      assert(modelIndex >= 0, "expected legacy session/set_model");
      assert(promptIndex > modelIndex, "model must be applied before the prompt");
      assert.equal(
        payloads
          .slice(modelIndex + 1, promptIndex)
          .some(
            (payload) =>
              payload.method === "session/set_config_option" &&
              (payload.params as { configId?: unknown } | undefined)?.configId ===
                "reasoning_effort",
          ),
        false,
        "cleared effort must not be re-applied after a legacy model change",
      );

      const acpxState = await readStoredSessionAcpxState(homeDir, sessionId);
      assert.deepEqual(acpxState.session_options, { model: "alternate-model" });
      assert.equal(
        (acpxState.desired_config_options as Record<string, unknown> | undefined)?.reasoning_effort,
        undefined,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: set model rejects with clear error on ACP invalid params", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const invalidModelAgentCommand = `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --set-session-model-invalid-params`;

    try {
      // Create session
      const created = await runCli(
        ["--agent", invalidModelAgentCommand, "--approve-all", "--cwd", cwd, "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      // Attempt model switch — should fail with enriched error
      const setResult = await runCli(
        [
          "--agent",
          invalidModelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "set",
          "model",
          "bad-model",
        ],
        homeDir,
      );
      assert.notEqual(setResult.code, 0, "expected non-zero exit");
      assert.match(setResult.stderr, /rejected session\/set_config_option/i);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: status shows model after session creation with --model", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const modelAgentCommand = `${MOCK_AGENT_COMMAND} --advertise-models`;

    try {
      // Create session with --model
      const created = await runCli(
        [
          "--agent",
          modelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--model",
          "smart-model",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      // Check status JSON
      const status = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "--format", "json", "status"],
        homeDir,
      );
      assert.equal(status.code, 0, status.stderr);

      const statusPayload = JSON.parse(status.stdout.trim()) as {
        model?: string;
        mode?: string;
        availableModels?: string[];
      };
      assert.equal(statusPayload.model, "smart-model");
      assert(Array.isArray(statusPayload.availableModels), "expected availableModels array");

      // Check status text
      const statusText = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "status"],
        homeDir,
      );
      assert.equal(statusText.code, 0, statusText.stderr);
      assert.match(statusText.stdout, /model: smart-model/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: status shows updated model after set model", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const modelAgentCommand = `${LOAD_CAPABLE_MOCK_AGENT_COMMAND} --advertise-models`;

    try {
      // Create session with --model
      const created = await runCli(
        [
          "--agent",
          modelAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--model",
          "fast-model",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const warmPrompt = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "prompt", "echo warm"],
        homeDir,
      );
      assert.equal(warmPrompt.code, 0, warmPrompt.stderr);

      // Switch model
      const setResult = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "set", "model", "gpt-5.4"],
        homeDir,
      );
      assert.equal(setResult.code, 0, setResult.stderr);

      const followUp = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "prompt", "echo follow-up"],
        homeDir,
      );
      assert.equal(followUp.code, 0, followUp.stderr);

      // Check status JSON — should show updated model
      const status = await runCli(
        ["--agent", modelAgentCommand, "--approve-all", "--cwd", cwd, "--format", "json", "status"],
        homeDir,
      );
      assert.equal(status.code, 0, status.stderr);

      const statusPayload = JSON.parse(status.stdout.trim()) as { model?: string };
      assert.equal(statusPayload.model, "gpt-5.4");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: sessions list uses agent session/list pagination and metadata", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const listAgentCommand = `${MOCK_AGENT_COMMAND} --supports-list-sessions --list-page-size 1`;

    try {
      const firstPage = await runCli(
        [
          "--agent",
          listAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "list",
          "--filter-cwd",
          ".",
        ],
        homeDir,
      );
      assert.equal(firstPage.code, 0, firstPage.stderr);
      const firstPayload = JSON.parse(firstPage.stdout.trim()) as {
        _meta?: { source?: string };
        source?: string;
        cwd?: string;
        nextCursor?: string | null;
        sessions?: Array<{
          sessionId?: string;
          cwd?: string;
          title?: string | null;
          _meta?: { messageCount?: number };
        }>;
      };
      assert.equal(firstPayload._meta?.source, "mock-agent-list");
      assert.equal(firstPayload.source, "agent");
      assert.equal(firstPayload.cwd, cwd);
      assert.equal(firstPayload.nextCursor, "1");
      assert.equal(firstPayload.sessions?.length, 1);
      assert.equal(firstPayload.sessions?.[0]?.sessionId, "mock-session-alpha");
      assert.equal(firstPayload.sessions?.[0]?.cwd, cwd);
      assert.equal(firstPayload.sessions?.[0]?.title, "Alpha task");
      assert.equal(firstPayload.sessions?.[0]?._meta?.messageCount, 2);

      const secondPage = await runCli(
        [
          "--agent",
          listAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "list",
          "--filter-cwd",
          ".",
          "--cursor",
          "1",
        ],
        homeDir,
      );
      assert.equal(secondPage.code, 0, secondPage.stderr);
      const secondPayload = JSON.parse(secondPage.stdout.trim()) as {
        cursor?: string;
        nextCursor?: string | null;
        sessions?: Array<{ sessionId?: string }>;
      };
      assert.equal(secondPayload.cursor, "1");
      assert.equal(secondPayload.nextCursor ?? null, null);
      assert.equal(secondPayload.sessions?.length, 1);
      assert.equal(secondPayload.sessions?.[0]?.sessionId, "mock-session-gamma");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: sessions list falls back to local records when agent lacks session/list", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as { acpxRecordId?: string };

      const listed = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "list"],
        homeDir,
      );
      assert.equal(listed.code, 0, listed.stderr);
      const listedPayload = JSON.parse(listed.stdout.trim()) as Array<{
        acpxRecordId?: string;
        cwd?: string;
      }>;
      assert.equal(Array.isArray(listedPayload), true);
      assert.equal(
        listedPayload.some(
          (session) => session.acpxRecordId === createdPayload.acpxRecordId && session.cwd === cwd,
        ),
        true,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: perf metrics capture writes ndjson records for CLI runs", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const metricsPath = path.join(homeDir, "perf", "metrics.ndjson");

    try {
      const result = await runCli([...baseExecArgs(cwd), "echo hello"], homeDir, {
        env: {
          ACPX_PERF_METRICS_FILE: metricsPath,
        },
      });
      assert.equal(result.code, 0, result.stderr);

      const payload = await fs.readFile(metricsPath, "utf8");
      const records = payload
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as { role?: string; metrics?: { timings?: Record<string, unknown> } },
        );

      assert.equal(records.length >= 1, true);
      assert.equal(
        records.some((record) => record.role === "cli"),
        true,
      );
      assert.equal(
        records.some(
          (record) =>
            record.metrics &&
            typeof record.metrics === "object" &&
            record.metrics.timings &&
            Object.keys(record.metrics.timings).length > 0,
        ),
        true,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: perf metrics capture checkpoints queue-owner turns before owner exit", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const metricsPath = path.join(homeDir, "perf", "metrics.ndjson");

    try {
      const created = await runCli([...baseAgentArgs(cwd), "sessions", "new"], homeDir, {
        env: {
          ACPX_PERF_METRICS_FILE: metricsPath,
        },
      });
      assert.equal(created.code, 0, created.stderr);

      const prompted = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "--ttl", "5", "prompt", "echo warm"],
        homeDir,
        {
          env: {
            ACPX_PERF_METRICS_FILE: metricsPath,
          },
        },
      );
      assert.equal(prompted.code, 0, prompted.stderr);
      assert.match(prompted.stdout, /warm/);

      const queueOwnerRecord = await waitForValue(async () => {
        const records = await readPerfRecords(metricsPath);
        return records.find(
          (record) =>
            record.role === "queue_owner" &&
            record.reason === "checkpoint" &&
            typeof record.metrics === "object" &&
            typeof record.metrics?.timings === "object" &&
            Object.keys(record.metrics.timings ?? {}).length > 0,
        );
      });
      assert(queueOwnerRecord, "expected queue owner checkpoint record before owner exit");
      assert.equal((readPerfTimingCount(queueOwnerRecord, "session.write_record") ?? 0) >= 2, true);

      const status = await runCli([...baseAgentArgs(cwd), "--format", "json", "status"], homeDir);
      assert.equal(status.code, 0, status.stderr);
      const statusPayload = JSON.parse(status.stdout.trim()) as { status?: string };
      assert.equal(statusPayload.status, "alive");

      const closed = await runCli([...baseAgentArgs(cwd), "sessions", "close"], homeDir);
      assert.equal(closed.code, 0, closed.stderr);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: perf report tolerates malformed lines and keeps role and gauge summaries", async () => {
  const metricsPath = path.join(os.tmpdir(), `acpx-perf-report-${Date.now()}.ndjson`);

  try {
    await fs.writeFile(
      metricsPath,
      [
        JSON.stringify({
          role: "cli",
          metrics: {
            counters: {
              sample: 1,
            },
            timings: {
              "runtime.exec.start": {
                count: 1,
                totalMs: 12.5,
                maxMs: 12.5,
              },
            },
          },
        }),
        "not-json",
        JSON.stringify({
          role: "queue_owner",
          metrics: {
            gauges: {
              "queue.owner.depth": 2,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const result = await runPerfReport(metricsPath);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      droppedLines?: number;
      gauges?: Record<string, unknown>;
      byRole?: Record<string, { gauges?: Record<string, unknown>; timings?: unknown[] }>;
    };
    assert.equal(payload.droppedLines, 1);
    assert.equal(typeof payload.gauges?.["queue.owner.depth"], "object");
    assert.equal(Array.isArray(payload.byRole?.queue_owner?.timings), true);
    assert.equal(typeof payload.byRole?.queue_owner?.gauges?.["queue.owner.depth"], "object");
  } finally {
    await fs.rm(metricsPath, { force: true });
  }
});

test("integration: perf metrics capture preserves SIGTERM termination semantics", async () => {
  const metricsPath = path.join(os.tmpdir(), `acpx-perf-signal-${Date.now()}.ndjson`);

  try {
    const result = await new Promise<CliRunResult>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          [
            "import { installPerfMetricsCapture } from './dist-test/src/perf-metrics-capture.js';",
            "import { recordPerfDuration } from './dist-test/src/perf-metrics.js';",
            `installPerfMetricsCapture({ filePath: ${JSON.stringify(metricsPath)} });`,
            "recordPerfDuration('signal.test', 1);",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.once("error", reject);
      setTimeout(() => {
        child.kill("SIGTERM");
      }, 500);
      child.once("close", (code, signal) => {
        resolve({
          code,
          signal,
          stdout,
          stderr,
        });
      });
    });

    assert.equal(result.code === 143 || result.signal === "SIGTERM", true);
    const records = await readPerfRecords(metricsPath);
    assert.equal(records.length >= 1, true);
  } finally {
    await fs.rm(metricsPath, { force: true });
  }
});

test("integration: configured mcpServers are sent to session/new and session/load", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const loadCapableAgentCommand = `${MOCK_AGENT_COMMAND} --supports-load-session`;
    const loadCapableAgentArgs = [
      "--agent",
      loadCapableAgentCommand,
      "--approve-all",
      "--cwd",
      cwd,
    ];
    let sessionId: string | undefined;

    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          mcpServers: [
            {
              name: "linear-http",
              type: "http",
              url: "https://example.com/mcp",
            },
            {
              name: "local-stdio",
              type: "stdio",
              command: "./bin/local-mcp",
              args: ["--serve"],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const expectedMcpServers = [
      {
        name: "linear-http",
        type: "http",
        url: "https://example.com/mcp",
        headers: [],
      },
      {
        name: "local-stdio",
        command: "./bin/local-mcp",
        args: ["--serve"],
        env: [],
      },
    ];

    try {
      const execResult = await runCli(
        [...loadCapableAgentArgs, "--format", "json", "exec", "echo mcp-new"],
        homeDir,
      );
      assert.equal(execResult.code, 0, execResult.stderr);
      const execMessages = parseJsonRpcOutputLines(execResult.stdout);
      const newSessionRequest = execMessages.find(
        (message) => message.method === "session/new" && extractJsonRpcId(message) !== undefined,
      );
      assert(newSessionRequest, `expected session/new request in output:\n${execResult.stdout}`);
      assert.deepEqual(
        (newSessionRequest.params as { mcpServers?: unknown } | undefined)?.mcpServers,
        expectedMcpServers,
      );

      const created = await runCli(
        [...loadCapableAgentArgs, "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      sessionId = createdPayload.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      const promptResult = await runCli(
        [...loadCapableAgentArgs, "--format", "json", "prompt", "echo mcp-load"],
        homeDir,
      );
      assert.equal(promptResult.code, 0, promptResult.stderr);

      const promptMessages = parseJsonRpcOutputLines(promptResult.stdout);
      const loadSessionRequest = promptMessages.find(
        (message) => message.method === "session/load" && extractJsonRpcId(message) !== undefined,
      );
      assert(
        loadSessionRequest,
        `expected session/load request in output:\n${promptResult.stdout}`,
      );
      assert.deepEqual(
        (loadSessionRequest.params as { mcpServers?: unknown } | undefined)?.mcpServers,
        expectedMcpServers,
      );
    } finally {
      if (sessionId) {
        await runCli([...loadCapableAgentArgs, "--format", "json", "sessions", "close"], homeDir);
      }
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: --mcp-config loads session-scoped MCP servers", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-mcp-config-cwd-"));
    const mcpConfigPath = path.join(homeDir, "job-mcp.json");
    await fs.writeFile(
      mcpConfigPath,
      `${JSON.stringify(
        {
          mcpServers: [
            {
              name: "job-stdio",
              type: "stdio",
              command: "./bin/job-mcp",
              args: ["--serve"],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    try {
      const result = await runCli(
        [
          "--agent",
          MOCK_AGENT_COMMAND,
          "--approve-all",
          "--cwd",
          cwd,
          "--mcp-config",
          mcpConfigPath,
          "--format",
          "json",
          "exec",
          "echo mcp-config",
        ],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);
      const messages = parseJsonRpcOutputLines(result.stdout);
      const newSessionRequest = messages.find(
        (message) => message.method === "session/new" && extractJsonRpcId(message) !== undefined,
      );
      assert(newSessionRequest, `expected session/new request in output:\n${result.stdout}`);
      assert.deepEqual(
        (newSessionRequest.params as { mcpServers?: unknown } | undefined)?.mcpServers,
        [
          {
            name: "job-stdio",
            command: "./bin/job-mcp",
            args: ["--serve"],
            env: [],
          },
        ],
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt text after the command does not trigger --mcp-config loading", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-mcp-config-prompt-cwd-"));
    try {
      const result = await runCli(
        [
          "--agent",
          MOCK_AGENT_COMMAND,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "exec",
          "--",
          "--mcp-config",
          "missing-mcp.json",
        ],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /unrecognized prompt: --mcp-config missing-mcp\.json/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt reconnect uses session/resume when advertised", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const resumeAgentArgs = [
      "--agent",
      RESUME_CAPABLE_MOCK_AGENT_COMMAND,
      "--approve-all",
      "--cwd",
      cwd,
    ];

    try {
      const created = await runCli(
        [...resumeAgentArgs, "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      assert.equal(typeof createdPayload.acpxRecordId, "string");

      const prompt = await runCli(
        [...resumeAgentArgs, "--format", "json", "prompt", "echo resume-method"],
        homeDir,
      );
      assert.equal(prompt.code, 0, prompt.stderr);

      const messages = parseJsonRpcOutputLines(prompt.stdout);
      const resumeRequest = messages.find(
        (message) => message.method === "session/resume" && extractJsonRpcId(message) !== undefined,
      );
      assert(resumeRequest, `expected session/resume request in output:\n${prompt.stdout}`);
      assert.equal(
        (resumeRequest.params as { sessionId?: unknown } | undefined)?.sessionId,
        createdPayload.acpxRecordId,
      );
      assert.equal(
        messages.some(
          (message) => message.method === "session/load" && extractJsonRpcId(message) !== undefined,
        ),
        false,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: timeout emits structured TIMEOUT json error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--timeout", "0.05", "exec", "sleep 500"],
        homeDir,
      );
      assert.equal(result.code, 3, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              jsonrpc?: string;
              error?: { code?: number; data?: { acpxCode?: string } };
            },
        );
      assert(payloads.length > 0, "expected at least one JSON payload");
      const timeoutError = payloads.find(
        (payload) => payload.jsonrpc === "2.0" && payload.error?.data?.acpxCode === "TIMEOUT",
      );
      assert(timeoutError, `expected timeout error payload in output:\n${result.stdout}`);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: gemini ACP startup timeout is surfaced as actionable error for gemini.cmd too", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-gemini-"));
    const fakeGeminiPath = path.join(fakeBinDir, "gemini.cmd");
    const previousTimeout = process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS;

    try {
      await fs.writeFile(
        fakeGeminiPath,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "0.33.0"\n  exit 0\nfi\nsleep 60\n',
        {
          encoding: "utf8",
          mode: 0o755,
        },
      );
      process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS = "100";

      const result = await runCli(
        [
          "--agent",
          `${JSON.stringify(fakeGeminiPath)} --acp`,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "exec",
          "say exactly: hi",
        ],
        homeDir,
        { timeoutMs: 10_000 },
      );

      assert.equal(result.code, 3, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              error?: { message?: string; data?: { acpxCode?: string; detailCode?: string } };
            },
        );
      const timeoutError = payloads.find(
        (payload) => payload.error?.data?.detailCode === "GEMINI_ACP_STARTUP_TIMEOUT",
      );
      assert(timeoutError, result.stdout);
      assert.equal(timeoutError.error?.data?.acpxCode, "TIMEOUT");
      assert.equal(timeoutError.error?.data?.detailCode, "GEMINI_ACP_STARTUP_TIMEOUT");
      assert.match(timeoutError.error?.message ?? "", /Gemini CLI ACP startup timed out/i);
      assert.match(timeoutError.error?.message ?? "", /API-key-based auth/i);
    } finally {
      if (previousTimeout == null) {
        delete process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS;
      } else {
        process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS = previousTimeout;
      }
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: built-in gemini falls back to --experimental-acp for Gemini CLI before 0.33.0", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-gemini-"));
    const fakeGeminiPath = path.join(fakeBinDir, "gemini");

    try {
      await fs.writeFile(
        fakeGeminiPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then',
          '  echo "0.32.9"',
          "  exit 0",
          "fi",
          'if [ "$1" = "--experimental-acp" ]; then',
          "  shift",
          `  exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`,
          "fi",
          'echo "unexpected gemini flag: $1" 1>&2',
          "exit 2",
          "",
        ].join("\n"),
        {
          encoding: "utf8",
          mode: 0o755,
        },
      );

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "gemini", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: built-in gemini keeps --acp for Gemini CLI 0.33.0 and newer", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-gemini-"));
    const fakeGeminiPath = path.join(fakeBinDir, "gemini");

    try {
      await fs.writeFile(
        fakeGeminiPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then',
          '  echo "0.33.0-preview.11"',
          "  exit 0",
          "fi",
          'if [ "$1" = "--acp" ]; then',
          "  shift",
          `  exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`,
          "fi",
          'echo "unexpected gemini flag: $1" 1>&2',
          "exit 2",
          "",
        ].join("\n"),
        {
          encoding: "utf8",
          mode: 0o755,
        },
      );

      const result = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "quiet", "gemini", "exec", "echo hello"],
        homeDir,
        {
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: copilot ACP unsupported binary is surfaced as actionable error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-copilot-"));
    const fakeCopilotPath = path.join(fakeBinDir, "copilot");

    try {
      await fs.writeFile(
        fakeCopilotPath,
        '#!/bin/sh\nif [ "$1" = "--help" ]; then\n  echo \'Usage: copilot [options]\'\n  exit 0\nfi\necho "error: unknown option \'$1\'" 1>&2\nexit 0\n',
        {
          encoding: "utf8",
          mode: 0o755,
        },
      );

      const result = await runCli(
        [
          "--agent",
          `${JSON.stringify(fakeCopilotPath)} --acp --stdio`,
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "new",
          "--name",
          "copilot-timeout",
        ],
        homeDir,
        { timeoutMs: 10_000 },
      );

      assert.equal(result.code, 1, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              error?: { message?: string; data?: { acpxCode?: string; detailCode?: string } };
            },
        );
      const unsupportedError = payloads.find(
        (payload) => payload.error?.data?.detailCode === "COPILOT_ACP_UNSUPPORTED",
      );
      assert(unsupportedError, result.stdout);
      assert.equal(unsupportedError.error?.data?.acpxCode, "RUNTIME");
      assert.equal(unsupportedError.error?.data?.detailCode, "COPILOT_ACP_UNSUPPORTED");
      assert.match(
        unsupportedError.error?.message ?? "",
        /Copilot CLI release that supports --acp --stdio/i,
      );
      assert.match(unsupportedError.error?.message ?? "", /Upgrade GitHub Copilot CLI/i);
    } finally {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: claude ACP session creation timeout is surfaced as actionable error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fake-claude-acp-"));
    const fakeClaudeAcpPath = path.join(fakeBinDir, "claude-agent-acp");
    const previousTimeout = process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;

    try {
      await fs.writeFile(
        fakeClaudeAcpPath,
        `#!/bin/sh\nexec node ${JSON.stringify(MOCK_AGENT_PATH)} --hang-on-new-session "$@"\n`,
        {
          encoding: "utf8",
          mode: 0o755,
        },
      );
      process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS = "100";

      const result = await runCli(
        [
          "--agent",
          JSON.stringify(fakeClaudeAcpPath),
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "new",
          "--name",
          "claude-timeout",
        ],
        homeDir,
        { timeoutMs: 10_000 },
      );

      assert.equal(result.code, 3, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              error?: { message?: string; data?: { acpxCode?: string; detailCode?: string } };
            },
        );
      const timeoutError = payloads.find(
        (payload) => payload.error?.data?.detailCode === "CLAUDE_ACP_SESSION_CREATE_TIMEOUT",
      );
      assert(timeoutError, result.stdout);
      assert.equal(timeoutError.error?.data?.acpxCode, "TIMEOUT");
      assert.equal(timeoutError.error?.data?.detailCode, "CLAUDE_ACP_SESSION_CREATE_TIMEOUT");
      assert.match(timeoutError.error?.message ?? "", /Claude ACP session creation timed out/i);
      assert.match(timeoutError.error?.message ?? "", /nonInteractivePermissions=deny/i);
      assert.match(timeoutError.error?.message ?? "", /acpx claude exec/i);
    } finally {
      if (previousTimeout == null) {
        delete process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
      } else {
        process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS = previousTimeout;
      }
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: non-interactive fail emits structured permission error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const writePath = path.join(cwd, "blocked.txt");

    try {
      const result = await runCli(
        [
          "--agent",
          MOCK_AGENT_COMMAND,
          "--approve-reads",
          "--non-interactive-permissions",
          "fail",
          "--cwd",
          cwd,
          "--format",
          "json",
          "exec",
          `write ${writePath} hello`,
        ],
        homeDir,
      );

      assert.equal(result.code, 5, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { jsonrpc?: string; error?: { code?: unknown } });
      assert(payloads.length > 0, "expected at least one JSON payload");
      const permissionError = payloads.find(
        (payload) => payload.jsonrpc === "2.0" && typeof payload.error?.code === "number",
      );
      assert(permissionError, `expected ACP error response in output:\n${result.stdout}`);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: permission policy emits structured escalation event", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const policyPath = path.join(cwd, "permission-policy.json");

    try {
      await fs.writeFile(policyPath, JSON.stringify({ escalate: ["execute"] }), "utf8");
      const result = await runCli(
        [
          "--agent",
          MOCK_AGENT_COMMAND,
          "--permission-policy",
          policyPath,
          "--cwd",
          cwd,
          "--format",
          "json",
          "exec",
          "permission execute Bash",
        ],
        homeDir,
      );

      assert.equal(result.code, 5, result.stderr);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { result?: unknown; type?: string });
      assert.equal(
        payloads.some((payload) => payload.type === "permission_escalation"),
        false,
        result.stdout,
      );
      const escalation = payloads
        .map((payload) => {
          const resultPayload =
            payload.result && typeof payload.result === "object"
              ? (payload.result as { _meta?: unknown })
              : undefined;
          const meta =
            resultPayload?._meta && typeof resultPayload._meta === "object"
              ? (resultPayload._meta as { acpx?: unknown })
              : undefined;
          const acpx =
            meta?.acpx && typeof meta.acpx === "object"
              ? (meta.acpx as { permissionEscalation?: unknown })
              : undefined;
          return acpx?.permissionEscalation as
            | { toolKind?: string; toolName?: string; toolTitle?: string }
            | undefined;
        })
        .find(Boolean);
      assert.deepEqual(
        {
          toolKind: escalation?.toolKind,
          toolName: escalation?.toolName,
          toolTitle: escalation?.toolTitle,
        },
        { toolKind: "execute", toolName: "Bash", toolTitle: "Bash" },
        result.stdout,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: deferred permission policy reports action defer", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const policyPath = path.join(cwd, "permission-policy.json");

    try {
      await fs.writeFile(policyPath, JSON.stringify({ defer: ["execute"] }), "utf8");
      const result = await runCli(
        [
          "--agent",
          MOCK_AGENT_COMMAND,
          "--permission-policy",
          policyPath,
          "--cwd",
          cwd,
          "--format",
          "json",
          "exec",
          "permission execute Bash",
        ],
        homeDir,
      );

      assert.equal(result.code, 5, result.stderr);
      const escalation = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { result?: unknown })
        .map((payload) => {
          const resultPayload =
            payload.result && typeof payload.result === "object"
              ? (payload.result as { _meta?: unknown })
              : undefined;
          const meta =
            resultPayload?._meta && typeof resultPayload._meta === "object"
              ? (resultPayload._meta as { acpx?: unknown })
              : undefined;
          const acpx =
            meta?.acpx && typeof meta.acpx === "object"
              ? (meta.acpx as { permissionEscalation?: unknown })
              : undefined;
          return acpx?.permissionEscalation as
            | { action?: string; matchedRule?: string; message?: string }
            | undefined;
        })
        .find(Boolean);

      assert.deepEqual(
        {
          action: escalation?.action,
          matchedRule: escalation?.matchedRule,
          message: escalation?.message,
        },
        {
          action: "defer",
          matchedRule: "execute",
          message: "Permission deferral required for Bash",
        },
        result.stdout,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: json-strict suppresses runtime stderr diagnostics", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const writePath = path.join(cwd, "blocked.txt");

    try {
      const result = await runCli(
        [
          "--agent",
          MOCK_AGENT_COMMAND,
          "--approve-reads",
          "--non-interactive-permissions",
          "fail",
          "--cwd",
          cwd,
          "--format",
          "json",
          "--json-strict",
          "exec",
          `write ${writePath} hello`,
        ],
        homeDir,
      );

      assert.equal(result.code, 5);
      assert.equal(result.stderr.trim(), "");

      const payloads = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { jsonrpc?: string; error?: { code?: unknown } });
      assert(payloads.length > 0, "expected at least one JSON payload");
      const permissionError = payloads.find(
        (payload) => payload.jsonrpc === "2.0" && typeof payload.error?.code === "number",
      );
      assert(permissionError, `expected ACP error response in output:\n${result.stdout}`);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: json-strict exec success emits JSON-RPC lines only", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--json-strict", "exec", "echo strict-success"],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr.trim(), "");
      const payloads = parseJsonRpcOutputLines(result.stdout);
      assert(
        payloads.some((payload) => Object.hasOwn(payload, "result")),
        "expected at least one JSON-RPC result payload",
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: json-strict exec retries without emitting stderr notices", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "--json-strict",
          "--prompt-retries",
          "1",
          "exec",
          "retryable-error-once",
        ],
        homeDir,
      );

      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr.trim(), "");

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const promptRequests = payloads.filter((payload) => payload.method === "session/prompt");
      assert.equal(promptRequests.length, 2, result.stdout);
      assert.equal(
        payloads.some(
          (payload) => extractAgentMessageChunkText(payload) === "recovered after retry",
        ),
        true,
        result.stdout,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: queued prompt honors per-request prompt retries on warm owner", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const warmup = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "quiet",
          "--ttl",
          "3600",
          "prompt",
          "say exactly: warm-owner-no-retries",
        ],
        homeDir,
      );
      assert.equal(warmup.code, 0, warmup.stderr);
      assert.match(warmup.stdout, /warm-owner-no-retries/);

      const retryingPrompt = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "--json-strict",
          "--prompt-retries",
          "1",
          "prompt",
          "retryable-error-once",
        ],
        homeDir,
      );
      assert.equal(retryingPrompt.code, 0, retryingPrompt.stderr);
      assert.equal(retryingPrompt.stderr.trim(), "");

      const payloads = parseJsonRpcOutputLines(retryingPrompt.stdout);
      const promptRequests = payloads.filter((payload) => payload.method === "session/prompt");
      assert.equal(promptRequests.length, 2, retryingPrompt.stdout);
      assert.equal(
        payloads.some(
          (payload) => extractAgentMessageChunkText(payload) === "recovered after retry",
        ),
        true,
        retryingPrompt.stdout,
      );
    } finally {
      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "close"], homeDir).catch(
        () => {},
      );
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: queued prompt without retry flag ignores warm owner startup retries", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const warmup = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "quiet",
          "--ttl",
          "3600",
          "--prompt-retries",
          "1",
          "prompt",
          "say exactly: warm-owner-with-retries",
        ],
        homeDir,
      );
      assert.equal(warmup.code, 0, warmup.stderr);
      assert.match(warmup.stdout, /warm-owner-with-retries/);

      const noRetryPrompt = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "--json-strict",
          "prompt",
          "retryable-error-once",
        ],
        homeDir,
      );
      assert.equal(noRetryPrompt.code, 1, noRetryPrompt.stderr);
      assert.equal(noRetryPrompt.stderr.trim(), "");

      const payloads = parseJsonRpcOutputLines(noRetryPrompt.stdout);
      const promptRequests = payloads.filter((payload) => payload.method === "session/prompt");
      assert.equal(promptRequests.length, 1, noRetryPrompt.stdout);
      assert.equal(
        payloads.some(
          (payload) => extractAgentMessageChunkText(payload) === "recovered after retry",
        ),
        false,
        noRetryPrompt.stdout,
      );
    } finally {
      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "close"], homeDir).catch(
        () => {},
      );
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: fs/read_text_file through mock agent", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const readPath = path.join(cwd, "acpx-test-read.txt");
    await fs.writeFile(readPath, "mock read content", "utf8");

    try {
      const result = await runCli([...baseExecArgs(cwd), `read ${readPath}`], homeDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /mock read content/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: --suppress-reads hides read file body in text format", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const readPath = path.join(cwd, "acpx-test-read-tools.txt");
    await fs.writeFile(readPath, "mock read content", "utf8");

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--suppress-reads", "exec", `read-tool ${readPath}`],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /\[tool\] Read/);
      assert.match(result.stdout, /\[read output suppressed\]/);
      assert.doesNotMatch(result.stdout, /mock read content/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: --suppress-reads hides read file body in json format", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const readPath = path.join(cwd, "acpx-test-read-json.txt");
    await fs.writeFile(readPath, "mock read content", "utf8");

    try {
      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "--suppress-reads", "exec", `read ${readPath}`],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);
      const payloads = parseJsonRpcOutputLines(result.stdout);
      const readResponse = payloads.find((payload) => {
        if (!("result" in payload)) {
          return false;
        }
        return typeof (payload.result as { content?: unknown } | undefined)?.content === "string";
      });
      assert.equal(
        (readResponse?.result as { content?: string } | undefined)?.content,
        "[read output suppressed]",
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: late post-success tool updates are rendered before prompt exits", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const result = await runCli(
        [...baseAgentArgs(cwd), "--format", "text", "prompt", "late-tool 40 follow-up"],
        homeDir,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /writing now/);
      assert.match(result.stdout, /\[tool\] LateTool/);
      assert.match(result.stdout, /follow-up/);

      const closed = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "close"],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: fs/write_text_file through mock agent", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const writePath = path.join(cwd, "acpx-test-write.txt");

    try {
      const result = await runCli([...baseExecArgs(cwd), `write ${writePath} hello`], homeDir);
      assert.equal(result.code, 0, result.stderr);
      const content = await fs.readFile(writePath, "utf8");
      assert.equal(content, "hello");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: fs/read_text_file outside cwd is denied", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli([...baseExecArgs("/tmp"), "read /etc/hostname"], homeDir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout.toLowerCase(), /error:/);
  });
});

test("integration: terminal lifecycle create/output/wait/release", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli([...baseExecArgs(cwd), "terminal echo hello"], homeDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hello/);
      assert.match(result.stdout, /exit: 0/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: terminal kill leaves no orphan sleep process", async (t) => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const sleepSeconds = 4137;
    let before: Set<number>;
    try {
      before = await listSleepPids(sleepSeconds);
    } catch (error) {
      if (isProcessListUnavailable(error)) {
        t.skip("process listing unavailable");
        return;
      }
      throw error;
    }

    try {
      const result = await runCli(
        [...baseExecArgs(cwd), `kill-terminal sleep ${sleepSeconds}`],
        homeDir,
        {
          timeoutMs: 25_000,
        },
      );
      assert.equal(result.code, 0, result.stderr);
      try {
        await assertNoNewSleepProcesses(before, sleepSeconds);
      } catch (error) {
        if (isProcessListUnavailable(error)) {
          t.skip("process listing unavailable");
          return;
        }
        throw error;
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt reuses warm queue owner and agent pid across turns", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdEvent = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const sessionId = createdEvent.acpxRecordId;
      assert.equal(typeof sessionId, "string");
      const sessionRecordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(sessionId as string)}.json`,
      );

      const first = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "prompt", "echo first"],
        homeDir,
      );
      assert.equal(first.code, 0, first.stderr);
      assert.ok(first.stdout.trim().length > 0, "first quiet prompt output should not be empty");
      const firstRecord = JSON.parse(await fs.readFile(sessionRecordPath, "utf8")) as {
        pid?: number;
      };
      assert.equal(Number.isInteger(firstRecord.pid) && (firstRecord.pid ?? 0) > 0, true);

      const { lockPath } = queuePaths(homeDir, sessionId as string);
      const lockOne = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
        pid?: number;
      };
      assert.equal(typeof lockOne.pid, "number");

      const second = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "prompt", "echo second"],
        homeDir,
      );
      assert.equal(second.code, 0, second.stderr);
      assert.ok(second.stdout.trim().length > 0, "second quiet prompt output should not be empty");
      const secondRecord = JSON.parse(await fs.readFile(sessionRecordPath, "utf8")) as {
        pid?: number;
      };
      assert.equal(secondRecord.pid, firstRecord.pid);

      const lockTwo = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
        pid?: number;
      };
      assert.equal(lockTwo.pid, lockOne.pid);

      const closed = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "close"],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);
      if (typeof lockTwo.pid !== "number") {
        throw new Error("queue owner lock missing pid");
      }
      assert.equal(await waitForPidExit(lockTwo.pid, 5_000), true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: warm queue owner does not retain per-request permission policy", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const first = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--policy",
          '{"escalate":["execute"]}',
          "--format",
          "quiet",
          "--ttl",
          "5",
          "prompt",
          "permission execute Bash",
        ],
        homeDir,
      );
      assert.equal(first.code, 5, first.stderr);
      assert.match(first.stdout, /permission selected:reject/);

      const second = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "quiet",
          "--ttl",
          "5",
          "prompt",
          "permission execute Bash",
        ],
        homeDir,
      );
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /permission selected:allow/);

      const closed = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "close"],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: config agent command with flags is split correctly and stores protocol version", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
      await fs.writeFile(
        path.join(homeDir, ".acpx", "config.json"),
        `${JSON.stringify(
          {
            agents: {
              codex: {
                command: `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session`,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const created = await runCli(
        ["--approve-all", "--cwd", cwd, "--format", "json", "codex", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const sessionId = createdPayload.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      const storedRecordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(sessionId as string)}.json`,
      );
      const storedRecord = JSON.parse(await fs.readFile(storedRecordPath, "utf8")) as {
        protocol_version?: unknown;
      };
      assert.equal(storedRecord.protocol_version, 1);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt preserves the exact session when loadSession fails on an empty session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const callLog = path.join(cwd, "agent-calls.ndjson");
    const flakyLoadAgentCommand =
      `${MOCK_AGENT_COMMAND} --load-session-fails-on-empty ` +
      `--call-log ${JSON.stringify(callLog)}`;

    try {
      const created = await runCli(
        [
          "--agent",
          flakyLoadAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdEvent = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const originalSessionId = createdEvent.acpxRecordId;
      assert.equal(typeof originalSessionId, "string");

      const prompt = await runCli(
        [
          "--agent",
          flakyLoadAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "prompt",
          "echo recovered",
        ],
        homeDir,
      );
      assert.notEqual(prompt.code, 0, prompt.stderr);

      const payloads = prompt.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { jsonrpc?: string; result?: { stopReason?: string } });
      assert.equal(
        payloads.some((payload) => Object.hasOwn(payload, "error")),
        true,
        prompt.stdout,
      );
      assert.equal(
        payloads.some((payload) => payload.result?.stopReason === "end_turn"),
        false,
        prompt.stdout,
      );

      const storedRecordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(originalSessionId as string)}.json`,
      );
      const storedRecord = JSON.parse(await fs.readFile(storedRecordPath, "utf8")) as {
        acp_session_id?: string;
        messages?: unknown[];
      };

      assert.equal(storedRecord.acp_session_id, originalSessionId);
      const messages = Array.isArray(storedRecord.messages) ? storedRecord.messages : [];
      assert.equal(
        messages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "Agent" in (message as Record<string, unknown>),
        ),
        false,
      );

      const calls = await readMockAgentCalls(callLog);
      assert.equal(calls.filter((call) => call.method === "session/new").length, 1);
      assert.equal(calls.filter((call) => call.method === "session/prompt").length, 0);

      const fresh = await runCli(
        [
          "--agent",
          flakyLoadAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(fresh.code, 0, fresh.stderr);
      const freshSessionId = (JSON.parse(fresh.stdout.trim()) as { acpxRecordId?: string })
        .acpxRecordId;
      assert.equal(typeof freshSessionId, "string");
      assert.notEqual(freshSessionId, originalSessionId);
      assert.equal(
        (await readMockAgentCalls(callLog)).filter((call) => call.method === "session/new").length,
        2,
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt retries stop after partial prompt output", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli([...baseAgentArgs(cwd), "sessions", "new"], homeDir);
      assert.equal(created.code, 0, created.stderr);

      const result = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "--prompt-retries",
          "1",
          "prompt",
          "partial-retryable-error",
        ],
        homeDir,
      );
      assert.notEqual(result.code, 0, result.stderr);
      assert.equal(result.stderr.includes("retrying in"), false, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const partialUpdates = payloads.filter(
        (payload) => extractAgentMessageChunkText(payload) === "partial update",
      );
      assert.equal(partialUpdates.length, 1, result.stdout);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: exec retries stop after partial prompt output", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const result = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "--prompt-retries",
          "1",
          "exec",
          "partial-retryable-error",
        ],
        homeDir,
      );
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.stderr.includes("retrying in"), false, result.stderr);

      const payloads = parseJsonRpcOutputLines(result.stdout);
      const partialUpdates = payloads.filter(
        (payload) => extractAgentMessageChunkText(payload) === "partial update",
      );
      assert.equal(partialUpdates.length, 1, result.stdout);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt preserves the exact session when loadSession returns not found", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const callLog = path.join(cwd, "agent-calls.ndjson");
    const notFoundLoadAgentCommand =
      `${MOCK_AGENT_COMMAND} --supports-load-session --load-session-not-found ` +
      `--call-log ${JSON.stringify(callLog)}`;

    try {
      const created = await runCli(
        [
          "--agent",
          notFoundLoadAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "sessions",
          "new",
        ],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdEvent = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const originalSessionId = createdEvent.acpxRecordId;
      assert.equal(typeof originalSessionId, "string");

      const prompt = await runCli(
        [
          "--agent",
          notFoundLoadAgentCommand,
          "--approve-all",
          "--cwd",
          cwd,
          "--format",
          "json",
          "prompt",
          "echo recovered",
        ],
        homeDir,
      );
      assert.notEqual(prompt.code, 0, prompt.stderr);

      const payloads = prompt.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { jsonrpc?: string; result?: { stopReason?: string } });

      assert.equal(
        payloads.some((payload) => Object.hasOwn(payload, "error")),
        true,
        prompt.stdout,
      );
      assert.equal(
        payloads.some((payload) => payload.result?.stopReason === "end_turn"),
        false,
        prompt.stdout,
      );

      const storedRecordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(originalSessionId as string)}.json`,
      );
      const storedRecord = JSON.parse(await fs.readFile(storedRecordPath, "utf8")) as {
        acp_session_id?: string;
      };
      assert.equal(storedRecord.acp_session_id, originalSessionId);

      const calls = await readMockAgentCalls(callLog);
      assert.equal(calls.filter((call) => call.method === "session/new").length, 1);
      assert.equal(calls.filter((call) => call.method === "session/prompt").length, 0);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: load replay session/update notifications are suppressed from output and event log", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const replayText = "replay-load-chunk";
    const freshText = "fresh-after-load";
    const replayLoadAgentCommand =
      `${MOCK_AGENT_COMMAND} --supports-load-session ` +
      `--replay-load-session-updates --load-replay-text ${replayText}`;
    const replayAgentArgs = ["--agent", replayLoadAgentCommand, "--approve-all", "--cwd", cwd];
    let sessionId: string | undefined;

    try {
      const created = await runCli(
        [...replayAgentArgs, "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      sessionId = createdPayload.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      const prompt = await runCli(
        [...replayAgentArgs, "--format", "json", "prompt", `echo ${freshText}`],
        homeDir,
      );
      assert.equal(prompt.code, 0, prompt.stderr);

      const outputMessages = parseJsonRpcOutputLines(prompt.stdout);
      const outputChunkTexts = new Set(
        outputMessages
          .map((message) => extractAgentMessageChunkText(message))
          .filter((text): text is string => typeof text === "string"),
      );

      assert.equal(outputChunkTexts.has(replayText), false, prompt.stdout);
      assert.equal(outputChunkTexts.has(freshText), true, prompt.stdout);

      const loadRequest = outputMessages.find((message) => {
        return message.method === "session/load" && extractJsonRpcId(message) !== undefined;
      });
      assert(loadRequest, `expected session/load request in output:\n${prompt.stdout}`);

      const loadRequestId = extractJsonRpcId(loadRequest);
      assert.notEqual(loadRequestId, undefined);
      assert.equal(
        outputMessages.some(
          (message) =>
            extractJsonRpcId(message) === loadRequestId && Object.hasOwn(message, "result"),
        ),
        true,
        prompt.stdout,
      );

      const recordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(sessionId as string)}.json`,
      );
      const storedRecord = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
        event_log?: {
          active_path?: string;
        };
      };
      const activeEventPath = storedRecord.event_log?.active_path;
      assert.equal(typeof activeEventPath, "string");

      const eventLog = await fs.readFile(activeEventPath as string, "utf8");
      const eventMessages = eventLog
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const eventChunkTexts = new Set(
        eventMessages
          .map((message) => extractAgentMessageChunkText(message))
          .filter((text): text is string => typeof text === "string"),
      );

      assert.equal(eventChunkTexts.has(replayText), false, eventLog);
      assert.equal(eventChunkTexts.has(freshText), true, eventLog);
    } finally {
      if (sessionId) {
        const lock = await readQueueOwnerLock(homeDir, sessionId).catch(() => undefined);
        await runCli([...replayAgentArgs, "--format", "json", "sessions", "close"], homeDir);
        if (lock) {
          await waitForPidExit(lock.pid, 5_000);
        }
      }
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: cancel yields cancelled stopReason without queue error", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    let sessionId: string | undefined;

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      sessionId = createdPayload.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      const promptChild = spawn(
        process.execPath,
        [CLI_PATH, ...baseAgentArgs(cwd), "--format", "json", "prompt", "sleep 5000"],
        {
          env: {
            ...process.env,
            HOME: homeDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      try {
        const doneEventPromise = waitForPromptDoneEvent(promptChild, 20_000, "prompt");

        let cancelled = false;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const cancelResult = await runCli(
            [...baseAgentArgs(cwd), "--format", "json", "cancel"],
            homeDir,
          );
          assert.equal(cancelResult.code, 0, cancelResult.stderr);

          const payload = JSON.parse(cancelResult.stdout.trim()) as {
            action?: string;
            cancelled?: boolean;
          };
          assert.equal(payload.action, "cancel_result");
          cancelled = payload.cancelled === true;
          if (cancelled) {
            break;
          }

          await sleep(100);
        }

        assert.equal(cancelled, true, "cancel command never reached active queue owner");

        const promptResult = await doneEventPromise;
        assert.equal(
          promptResult.events.some((event) => event.result?.stopReason === "cancelled"),
          true,
          promptResult.stdout,
        );
        assert.equal(
          promptResult.events.some((event) => Object.hasOwn(event, "error")),
          false,
          promptResult.stdout,
        );
      } finally {
        await stopChildProcess(promptChild, 5_000, "prompt");
        if (sessionId) {
          const lock = await readQueueOwnerLock(homeDir, sessionId).catch(() => undefined);
          await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "close"], homeDir);
          if (lock) {
            await waitForPidExit(lock.pid, 5_000);
          }
        }
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt exits after done while detached owner stays warm", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
        acpx_record_id?: string;
        acpSessionId?: string;
        acp_session_id?: string;
        sessionId?: string;
        session_id?: string;
      };
      const sessionId =
        createdPayload.acpxRecordId ??
        createdPayload.acpx_record_id ??
        createdPayload.acpSessionId ??
        createdPayload.acp_session_id ??
        createdPayload.sessionId ??
        createdPayload.session_id;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error(`missing session id in sessions new output: `);
      }

      const firstPromptStartedAt = Date.now();
      const firstPrompt = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "quiet",
          "--ttl",
          "3600",
          "prompt",
          "say exactly: warm-owner-ready",
        ],
        homeDir,
      );
      const firstPromptDurationMs = Date.now() - firstPromptStartedAt;
      assert.equal(firstPrompt.code, 0, firstPrompt.stderr);
      assert.match(firstPrompt.stdout, /warm-owner-ready/);
      assert.equal(
        firstPromptDurationMs < 8_000,
        true,
        `expected prompt to return quickly, got ${firstPromptDurationMs}ms`,
      );

      const lock = await readQueueOwnerLock(homeDir, sessionId);
      assert.equal(Number.isInteger(lock.pid) && lock.pid > 0, true);
      assert.equal(isPidAlive(lock.pid), true);

      const secondPrompt = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "prompt", "say exactly: second-turn"],
        homeDir,
      );
      assert.equal(secondPrompt.code, 0, secondPrompt.stderr);
      assert.match(secondPrompt.stdout, /second-turn/);

      const closed = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "close"],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);

      assert.equal(await waitForPidExit(lock.pid, 5_000), true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: prompt --no-wait is processed by the detached queue owner", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const queued = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "--ttl",
          "5",
          "prompt",
          "--no-wait",
          "say exactly: no-wait-done",
        ],
        homeDir,
      );
      assert.equal(queued.code, 0, queued.stderr);
      const queuedPayload = JSON.parse(queued.stdout.trim()) as {
        action?: string;
        acpxRecordId?: string;
      };
      assert.equal(queuedPayload.action, "prompt_queued");

      await waitFor(async () => {
        const history = await runCli(
          [...baseAgentArgs(cwd), "--format", "quiet", "sessions", "read"],
          homeDir,
        );
        assert.equal(history.code, 0, history.stderr);
        return history.stdout.includes("no-wait-done") ? history.stdout : null;
      }, 5_000);

      const closed = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "close"],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: sessions history shows in-flight prompt after prompt starts", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const promptChild = spawn(
        process.execPath,
        [CLI_PATH, ...baseAgentArgs(cwd), "--format", "quiet", "prompt", "sleep 1500"],
        {
          env: {
            ...process.env,
            HOME: homeDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      try {
        const history = await waitFor(async () => {
          const result = await runCli(
            [...baseAgentArgs(cwd), "--format", "quiet", "sessions", "history"],
            homeDir,
          );
          assert.equal(result.code, 0, result.stderr);
          return result.stdout.includes("sleep 1500") ? result.stdout : null;
        }, 5_000);

        assert.match(history, /sleep 1500/);
        assert.doesNotMatch(history, /No history/);

        const promptResult = await awaitChildClose(promptChild);
        assert.equal(promptResult.code, 0, promptResult.stderr);
        assert.match(promptResult.stdout, /slept 1500ms/);
      } finally {
        if (promptChild.exitCode == null && promptChild.signalCode == null) {
          promptChild.kill("SIGKILL");
          await awaitChildClose(promptChild).catch(() => {});
        }
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: sessions read shows assistant updates before the prompt finishes", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const promptChild = spawn(
        process.execPath,
        [
          CLI_PATH,
          ...baseAgentArgs(cwd),
          "--format",
          "quiet",
          "prompt",
          "stream-sleep 2500 foreground-live-update",
        ],
        {
          env: {
            ...process.env,
            HOME: homeDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      try {
        const history = await waitFor(async () => {
          const result = await runCli(
            [...baseAgentArgs(cwd), "--format", "json", "sessions", "read"],
            homeDir,
          );
          assert.equal(result.code, 0, result.stderr);
          const payload = JSON.parse(result.stdout.trim()) as {
            entries?: Array<{ role?: string; textPreview?: string }>;
          };
          const assistantEntry = payload.entries?.find(
            (entry) =>
              entry.role === "assistant" && entry.textPreview?.includes("foreground-live-update"),
          );
          return assistantEntry ? result.stdout : null;
        }, 5_000);

        assert.equal(promptChild.exitCode, null, "prompt should still be running");
        assert.match(history, /foreground-live-update/);
        assert.doesNotMatch(history, /stream-sleep done/);

        const promptResult = await awaitChildClose(promptChild);
        assert.equal(promptResult.code, 0, promptResult.stderr);
        assert.match(promptResult.stdout, /stream-sleep done: foreground-live-update/);
      } finally {
        if (promptChild.exitCode == null && promptChild.signalCode == null) {
          promptChild.kill("SIGKILL");
          await awaitChildClose(promptChild).catch(() => {});
        }
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: --no-wait stdin prompt checkpoints live assistant updates", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const queued = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "--ttl",
          "5",
          "prompt",
          "--no-wait",
          "--file",
          "-",
        ],
        homeDir,
        {
          stdin: "stream-sleep 5000 background-live-update",
        },
      );
      assert.equal(queued.code, 0, queued.stderr);
      const queuedPayload = JSON.parse(queued.stdout.trim()) as {
        action?: string;
      };
      assert.equal(queuedPayload.action, "prompt_queued");

      const history = await waitFor(async () => {
        const result = await runCli(
          [...baseAgentArgs(cwd), "--format", "json", "sessions", "read"],
          homeDir,
        );
        assert.equal(result.code, 0, result.stderr);
        const payload = JSON.parse(result.stdout.trim()) as {
          entries?: Array<{ role?: string; textPreview?: string }>;
        };
        const assistantEntry = payload.entries?.find(
          (entry) =>
            entry.role === "assistant" && entry.textPreview?.includes("background-live-update"),
        );
        return assistantEntry ? result.stdout : null;
      }, 5_000);

      assert.match(history, /background-live-update/);
      assert.doesNotMatch(history, /stream-sleep done/);

      const closed = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "close"],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: sessions close stays closed after live checkpoints", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const sessionId = createdPayload.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      const promptChild = spawn(
        process.execPath,
        [
          CLI_PATH,
          ...baseAgentArgs(cwd),
          "--format",
          "quiet",
          "prompt",
          "stream-sleep 5000 close-live-update",
        ],
        {
          env: {
            ...process.env,
            HOME: homeDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      try {
        await waitFor(async () => {
          const result = await runCli(
            [...baseAgentArgs(cwd), "--format", "json", "sessions", "read"],
            homeDir,
          );
          assert.equal(result.code, 0, result.stderr);
          const payload = JSON.parse(result.stdout.trim()) as {
            entries?: Array<{ role?: string; textPreview?: string }>;
          };
          const assistantEntry = payload.entries?.find(
            (entry) =>
              entry.role === "assistant" && entry.textPreview?.includes("close-live-update"),
          );
          return assistantEntry ? true : null;
        }, 5_000);

        const closed = await runCli(
          [...baseAgentArgs(cwd), "--format", "json", "sessions", "close"],
          homeDir,
        );
        assert.equal(closed.code, 0, closed.stderr);
        if (promptChild.exitCode == null && promptChild.signalCode == null) {
          await awaitChildClose(promptChild).catch(() => {});
        }

        const recordPath = path.join(
          homeDir,
          ".acpx",
          "sessions",
          `${encodeURIComponent(sessionId as string)}.json`,
        );
        const storedRecord = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
          closed?: boolean;
          closed_at?: string;
        };
        assert.equal(storedRecord.closed, true);
        assert.equal(typeof storedRecord.closed_at, "string");
      } finally {
        if (promptChild.exitCode == null && promptChild.signalCode == null) {
          promptChild.kill("SIGKILL");
          await awaitChildClose(promptChild).catch(() => {});
        }
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: session remains resumable after queue owner exits and agent has exited", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));

    try {
      // 1. Create a persistent session
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as {
        acpxRecordId?: string;
      };
      const sessionId = createdPayload.acpxRecordId;
      assert.equal(typeof sessionId, "string");

      // 2. Use a positive sub-millisecond TTL. It must floor to 1 ms rather than
      //    round to the zero sentinel, which would keep the owner alive forever.
      const prompt = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "quiet",
          "--ttl",
          "0.0001",
          "prompt",
          "echo oneshot-done",
        ],
        homeDir,
      );
      assert.equal(prompt.code, 0, prompt.stderr);
      assert.match(prompt.stdout, /oneshot-done/);

      // 3. Wait for the queue owner to exit after its 1 ms floored TTL.
      const { lockPath } = queuePaths(homeDir, sessionId as string);
      let ownerPid: number | undefined;
      try {
        const lockPayload = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
          pid?: number;
        };
        ownerPid = lockPayload.pid;
      } catch {
        // lock file may already be gone
      }

      if (typeof ownerPid === "number") {
        assert.equal(await waitForPidExit(ownerPid, 10_000), true, "queue owner did not exit");
      }

      // Give a moment for final writes
      await sleep(500);

      // 4. Read the session record from disk
      const recordPath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(sessionId as string)}.json`,
      );
      const storedRecord = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
        closed?: boolean;
        closed_at?: string;
        last_agent_exit_at?: string;
        last_agent_exit_code?: number | null;
      };

      // 5. Routine queue-owner shutdown must not permanently close
      //    a resumable persistent session.
      assert.equal(
        storedRecord.last_agent_exit_at != null,
        true,
        "expected last_agent_exit_at to be set (agent has exited)",
      );

      assert.equal(
        storedRecord.closed,
        false,
        "session should remain resumable after queue owner shutdown",
      );

      assert.equal(
        storedRecord.closed_at,
        undefined,
        "closed_at should remain unset for resumable sessions",
      );
    } finally {
      // Clean up: close session if it's still around
      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "close"], homeDir).catch(
        () => {},
      );
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

type MockAgentCall = {
  pid: number;
  parentPid: number;
  method: string;
  sessionId?: string;
  modeId?: string;
  modelId?: string;
  effort?: string;
  configId?: string;
  value?: string;
  text?: string;
};

async function readMockAgentCalls(callLogPath: string): Promise<MockAgentCall[]> {
  const contents = await fs.readFile(callLogPath, "utf8").catch(() => "");
  return contents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MockAgentCall);
}

function sessionRecordPath(homeDir: string, sessionId: string): string {
  return path.join(homeDir, ".acpx", "sessions", `${encodeURIComponent(sessionId)}.json`);
}

async function readStoredSessionAcpxState(
  homeDir: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(sessionRecordPath(homeDir, sessionId), "utf8");
  return (JSON.parse(raw) as { acpx?: Record<string, unknown> }).acpx ?? {};
}

async function storeSessionDesiredMode(
  homeDir: string,
  sessionId: string,
  modeId: string,
): Promise<void> {
  const recordPath = sessionRecordPath(homeDir, sessionId);
  const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
    acpx?: Record<string, unknown>;
  };
  record.acpx = { ...record.acpx, desired_mode_id: modeId };
  await fs.writeFile(recordPath, `${JSON.stringify(record)}\n`, "utf8");
}

async function readSessionStreamNotifications(
  homeDir: string,
  method: string,
): Promise<Array<Record<string, unknown>>> {
  const sessionsDir = path.join(homeDir, ".acpx", "sessions");
  const found: Array<Record<string, unknown>> = [];
  for (const name of await fs.readdir(sessionsDir)) {
    if (!name.endsWith(".stream.ndjson")) {
      continue;
    }
    const contents = await fs.readFile(path.join(sessionsDir, name), "utf8");
    for (const line of contents.split("\n")) {
      if (!line.includes(`"${method}"`)) {
        continue;
      }
      const parsed = JSON.parse(line) as { method?: string; params?: Record<string, unknown> };
      if (parsed.method === method && parsed.params) {
        found.push(parsed.params);
      }
    }
  }
  return found;
}

/**
 * A queue-owner restart is the common case, and the dangerous one: the record
 * survives, the adapter session behind it does not, and an adapter that starts
 * every session at a self-approving default hands a parked-everything session
 * its approvals back. The mode has to be re-asserted before the prompt that
 * relies on it, not merely stored.
 */
test("integration: a saved session mode is re-applied when a fresh queue owner rebinds the session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const callLog = path.join(cwd, "agent-calls.ndjson");
    const agentArgs = [
      "--agent",
      `${MOCK_AGENT_COMMAND} --supports-resume-session --call-log ${JSON.stringify(callLog)}`,
      "--approve-all",
      "--cwd",
      cwd,
    ];

    try {
      const created = await runCli([...agentArgs, "--format", "json", "sessions", "new"], homeDir);
      assert.equal(created.code, 0, created.stderr);
      const sessionId = (JSON.parse(created.stdout.trim()) as { acpxRecordId: string })
        .acpxRecordId;

      const warmed = await runCli(
        [...agentArgs, "--format", "quiet", "--ttl", "60", "prompt", "echo one"],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(warmed.code, 0, warmed.stderr);

      const setMode = await runCli(
        [...agentArgs, "--format", "quiet", "set-mode", "plan"],
        homeDir,
        {
          timeoutMs: 30_000,
        },
      );
      assert.equal(setMode.code, 0, setMode.stderr);
      assert.equal(
        (await readStoredSessionAcpxState(homeDir, sessionId)).desired_mode_id,
        "plan",
        "set-mode must persist the mode on the record",
      );

      const { pid } = await readQueueOwnerLock(homeDir, sessionId);
      process.kill(pid, "SIGKILL");
      assert.equal(await waitForPidExit(pid, 10_000), true, "queue owner did not exit");

      const afterRestart = await runCli(
        [...agentArgs, "--format", "quiet", "--ttl", "60", "prompt", "echo two"],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(afterRestart.code, 0, afterRestart.stderr);
      assert.match(afterRestart.stdout, /two/);

      const calls = await readMockAgentCalls(callLog);
      const promptIndex = calls.findIndex(
        (call) => call.method === "session/prompt" && call.text === "echo two",
      );
      assert.notEqual(promptIndex, -1, JSON.stringify(calls));
      const reboundAgentPid = calls[promptIndex]?.pid;
      const reapplyIndex = calls.findIndex(
        (call) =>
          call.method === "session/set_mode" &&
          call.modeId === "plan" &&
          call.pid === reboundAgentPid,
      );
      assert.notEqual(
        reapplyIndex,
        -1,
        `the fresh agent process never received session/set_mode: ${JSON.stringify(calls)}`,
      );
      assert.equal(
        reapplyIndex < promptIndex,
        true,
        `session/set_mode must precede the prompt: ${JSON.stringify(calls)}`,
      );
      // The mode the agent actually held while answering, which is the whole
      // point: a stored preference that arrives after the prompt is no mode.
      assert.equal(calls[promptIndex]?.modeId, "plan", JSON.stringify(calls));
    } finally {
      await runCli([...agentArgs, "--format", "json", "sessions", "close"], homeDir).catch(
        () => undefined,
      );
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: a mode the rebound adapter refuses is reported instead of passing for applied", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const callLog = path.join(cwd, "agent-calls.ndjson");
    const agentArgs = [
      "--agent",
      `${MOCK_AGENT_COMMAND} --supports-resume-session --set-session-mode-fails --call-log ${JSON.stringify(callLog)}`,
      "--approve-all",
      "--cwd",
      cwd,
    ];

    try {
      const created = await runCli([...agentArgs, "--format", "json", "sessions", "new"], homeDir);
      assert.equal(created.code, 0, created.stderr);
      const sessionId = (JSON.parse(created.stdout.trim()) as { acpxRecordId: string })
        .acpxRecordId;

      // The mode was accepted when it was set; the adapter has since stopped
      // accepting it, which is what an adapter upgrade looks like from here.
      await storeSessionDesiredMode(homeDir, sessionId, "plan");

      const prompted = await runCli(
        [...agentArgs, "--format", "quiet", "--ttl", "1", "prompt", "echo still-running"],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(prompted.code, 0, prompted.stderr);
      assert.match(prompted.stdout, /still-running/);

      const warnings = await readSessionStreamNotifications(homeDir, "_acpx/warning");
      assert.equal(warnings.length, 1, JSON.stringify(warnings));
      assert.equal(warnings[0]?.code, "SESSION_MODE_NOT_REAPPLIED");
      assert.equal(warnings[0]?.modeId, "plan");
      assert.match(String(warnings[0]?.message), /is not in force/);

      const calls = await readMockAgentCalls(callLog);
      const prompt = calls.find(
        (call) => call.method === "session/prompt" && call.text === "echo still-running",
      );
      assert.equal(
        prompt?.modeId,
        "auto",
        `the refused mode must not be reported as applied: ${JSON.stringify(calls)}`,
      );
    } finally {
      await runCli([...agentArgs, "--format", "json", "sessions", "close"], homeDir).catch(
        () => undefined,
      );
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

function baseAgentArgs(cwd: string): string[] {
  return ["--agent", LOAD_CAPABLE_MOCK_AGENT_COMMAND, "--approve-all", "--cwd", cwd];
}

function baseLoadCapableAgentArgs(cwd: string): string[] {
  return ["--agent", LOAD_CAPABLE_MOCK_AGENT_COMMAND, "--approve-all", "--cwd", cwd];
}

function baseExecArgs(cwd: string): string[] {
  return [...baseAgentArgs(cwd), "--format", "quiet", "exec"];
}

async function writeFakeCursorAgent(binDir: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(binDir, "cursor-agent.cmd"),
      [
        "@echo off",
        "setlocal",
        'if "%~1"=="acp" shift',
        `"${process.execPath}" "${MOCK_AGENT_PATH}" %*`,
        "",
      ].join("\r\n"),
      { encoding: "utf8" },
    );
    return;
  }

  await fs.writeFile(
    path.join(binDir, "cursor-agent"),
    [
      "#!/bin/sh",
      'if [ "$1" = "acp" ]; then',
      "  shift",
      "fi",
      `exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
}

async function writeFakeDroidAgent(binDir: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(binDir, "droid.cmd"),
      [
        "@echo off",
        "setlocal",
        'if /I "%~1"=="exec" shift',
        'if /I "%~1"=="--output-format" shift',
        'if /I "%~1"=="acp" shift',
        `"${process.execPath}" "${MOCK_AGENT_PATH}" %*`,
        "",
      ].join("\r\n"),
      { encoding: "utf8" },
    );
    return;
  }

  await fs.writeFile(
    path.join(binDir, "droid"),
    [
      "#!/bin/sh",
      'if [ "$1" = "exec" ]; then',
      "  shift",
      "fi",
      'if [ "$1" = "--output-format" ]; then',
      "  shift",
      "fi",
      'if [ "$1" = "acp" ]; then',
      "  shift",
      "fi",
      `exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
}

async function writeFakeClaudeAgent(binDir: string): Promise<string> {
  const binName = process.platform === "win32" ? "claude-agent-acp.cmd" : "claude-agent-acp";
  const binPath = path.join(binDir, binName);
  if (process.platform === "win32") {
    await fs.writeFile(
      binPath,
      ["@echo off", "setlocal", `"${process.execPath}" "${MOCK_AGENT_PATH}" %*`, ""].join("\r\n"),
      { encoding: "utf8" },
    );
    return binPath;
  }

  await fs.writeFile(
    binPath,
    ["#!/bin/sh", `exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`, ""].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  return binPath;
}

async function writeFakeDevinAgent(binDir: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(binDir, "devin.cmd"),
      [
        "@echo off",
        "setlocal",
        ":shift_known",
        'if "%~1"=="--model" shift & shift & goto shift_known',
        'if "%~1"=="acp" shift & goto shift_known',
        'if "%~1"=="--acp" shift & goto shift_known',
        'if "%~1"=="--experimental-acp" shift & goto shift_known',
        `"${process.execPath}" "${MOCK_AGENT_PATH}" %*`,
        "",
      ].join("\r\n"),
      { encoding: "utf8" },
    );
    return;
  }

  await fs.writeFile(
    path.join(binDir, "devin"),
    [
      "#!/bin/sh",
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      "    --model)",
      "      shift",
      '      [ "$#" -gt 0 ] && shift',
      "      ;;",
      "    acp|--acp|--experimental-acp)",
      "      shift",
      "      ;;",
      "    *)",
      "      break",
      "      ;;",
      "  esac",
      "done",
      `exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
}

async function writeFakeUvxFastAgentAcp(binDir: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(binDir, "uvx.cmd"),
      [
        "@echo off",
        "setlocal",
        'if "%~1"=="fast-agent-mcp" shift',
        'if "%~1"=="acp" shift',
        `"${process.execPath}" "${MOCK_AGENT_PATH}" %*`,
        "",
      ].join("\r\n"),
      { encoding: "utf8" },
    );
    return;
  }

  await fs.writeFile(
    path.join(binDir, "uvx"),
    [
      "#!/bin/sh",
      'if [ "$1" = "fast-agent-mcp" ]; then',
      "  shift",
      "fi",
      'if [ "$1" = "acp" ]; then',
      "  shift",
      "fi",
      `exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
}

async function writeFakeIflowAgent(binDir: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(binDir, "iflow.cmd"),
      [
        "@echo off",
        "setlocal",
        'if "%~1"=="--experimental-acp" shift',
        `"${process.execPath}" "${MOCK_AGENT_PATH}" %*`,
        "",
      ].join("\r\n"),
      { encoding: "utf8" },
    );
    return;
  }

  await fs.writeFile(
    path.join(binDir, "iflow"),
    [
      "#!/bin/sh",
      'if [ "$1" = "--experimental-acp" ]; then',
      "  shift",
      "fi",
      `exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
}

async function writeFakeGrokBuildAgent(binDir: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(binDir, "grok.cmd"),
      [
        "@echo off",
        "setlocal",
        'if not "%~1"=="agent" exit /b 2',
        'if not "%~2"=="stdio" exit /b 2',
        `"${process.execPath}" "${MOCK_AGENT_PATH}" %3 %4 %5 %6 %7 %8 %9`,
        "",
      ].join("\r\n"),
      { encoding: "utf8" },
    );
    return;
  }

  await fs.writeFile(
    path.join(binDir, "grok"),
    [
      "#!/bin/sh",
      'if [ "$1" = "agent" ] && [ "$2" = "stdio" ]; then',
      "  shift",
      "  shift",
      "else",
      '  echo "unexpected grok command: $*" 1>&2',
      "  exit 2",
      "fi",
      `exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
}

async function writeFakePoolAgent(binDir: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(binDir, "pool.cmd"),
      [
        "@echo off",
        "setlocal",
        'if not "%~1"=="acp" exit /b 2',
        `"${process.execPath}" "${MOCK_AGENT_PATH}" %2 %3 %4 %5 %6 %7 %8 %9`,
        "",
      ].join("\r\n"),
      { encoding: "utf8" },
    );
    return;
  }

  await fs.writeFile(
    path.join(binDir, "pool"),
    [
      "#!/bin/sh",
      'if [ "$1" = "acp" ]; then',
      "  shift",
      "else",
      '  echo "unexpected pool command: $*" 1>&2',
      "  exit 2",
      "fi",
      `exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
}

async function writeFakeZeroClawAgent(binDir: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(binDir, "zeroclaw.cmd"),
      [
        "@echo off",
        "setlocal",
        'if not "%~1"=="acp" exit /b 2',
        `"${process.execPath}" "${MOCK_AGENT_PATH}" %2 %3 %4 %5 %6 %7 %8 %9`,
        "",
      ].join("\r\n"),
      { encoding: "utf8" },
    );
    return;
  }

  await fs.writeFile(
    path.join(binDir, "zeroclaw"),
    [
      "#!/bin/sh",
      'if [ "$1" = "acp" ]; then',
      "  shift",
      "else",
      '  echo "unexpected zeroclaw command: $*" 1>&2',
      "  exit 2",
      "fi",
      `exec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
}

async function writeFakeQoderAgent(binDir: string, argLogPath?: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(binDir, "qodercli.cmd"),
      [
        "@echo off",
        "setlocal",
        ...(argLogPath ? [`echo %*>> "${argLogPath}"`] : []),
        ":shift_known",
        'if "%~1"=="--acp" shift & goto shift_known',
        'if /I "%~1"=="--max-turns" shift & shift & goto shift_known',
        'if /I "%~1"=="--allowed-tools" shift & shift & goto shift_known',
        'if /I "%~1"=="--disallowed-tools" shift & shift & goto shift_known',
        'echo %~1 | findstr /B /C:"--max-turns=" >nul && shift & goto shift_known',
        'echo %~1 | findstr /B /C:"--allowed-tools=" >nul && shift & goto shift_known',
        'echo %~1 | findstr /B /C:"--disallowed-tools=" >nul && shift & goto shift_known',
        `"${process.execPath}" "${MOCK_AGENT_PATH}" --supports-load-session %*`,
        "",
      ].join("\r\n"),
      { encoding: "utf8" },
    );
    return;
  }

  await fs.writeFile(
    path.join(binDir, "qodercli"),
    [
      "#!/bin/sh",
      ...(argLogPath ? [`printf '%s\\n' "$*" >> ${JSON.stringify(argLogPath)}`] : []),
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      "    --acp|--max-turns=*|--allowed-tools=*|--disallowed-tools=*)",
      "      shift",
      "      ;;",
      "    --max-turns|--allowed-tools|--disallowed-tools)",
      "      shift",
      '      [ "$#" -gt 0 ] && shift',
      "      ;;",
      "    *)",
      "      break",
      "      ;;",
      "  esac",
      "done",
      `exec "${process.execPath}" "${MOCK_AGENT_PATH}" --supports-load-session "$@"`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-home-"));
  try {
    await run(tempHome);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

async function waitForFlowRunDir(outputRoot: string, flowName: string): Promise<string> {
  return await waitFor(async () => {
    const entries = await fs.readdir(outputRoot).catch(() => []);
    const match = entries.find((entry) => entry.includes(flowName));
    return match ? path.join(outputRoot, match) : null;
  }, 5_000);
}

async function readFlowRunJson(runDir: string): Promise<Record<string, unknown>> {
  const payload = await fs.readFile(path.join(runDir, "projections", "run.json"), "utf8");
  return JSON.parse(payload) as Record<string, unknown>;
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value != null) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for condition");
}

async function runCli(
  args: string[],
  homeDir: string,
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  return await runCliWithEntry(CLI_PATH, args, homeDir, options);
}

async function runCliWithEntry(
  entryPath: string,
  args: string[],
  homeDir: string,
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath, ...args], {
      env: {
        ...process.env,
        HOME: homeDir,
        ...options.env,
      },
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs ?? 15_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms: acpx ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    if (options.stdin != null) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

async function awaitChildClose(child: ReturnType<typeof spawn>): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function runPerfReport(filePath: string): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", "scripts/perf-report.ts", filePath], {
      env: {
        ...process.env,
        NODE_V8_COVERAGE: "",
      },
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

async function readPerfRecords(metricsPath: string): Promise<
  Array<{
    role?: string;
    reason?: string;
    metrics?: {
      timings?: Record<string, unknown>;
    };
  }>
> {
  try {
    const payload = await fs.readFile(metricsPath, "utf8");
    return payload
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            role?: string;
            reason?: string;
            metrics?: { timings?: Record<string, unknown> };
          },
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function readPerfTimingCount(
  record: {
    metrics?: {
      timings?: Record<string, unknown>;
    };
  },
  name: string,
): number | undefined {
  const value = record.metrics?.timings?.[name];
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const count = (value as { count?: unknown }).count;
  return typeof count === "number" ? count : undefined;
}

async function waitForValue<T>(
  load: () => Promise<T | undefined>,
  timeoutMs = 2_000,
): Promise<T | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await load();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

type PromptEvent = {
  jsonrpc?: string;
  method?: string;
  params?: unknown;
  result?: {
    stopReason?: string;
  };
  error?: {
    code?: unknown;
    message?: string;
  };
};

type PromptDoneResult = {
  events: PromptEvent[];
  stdout: string;
  stderr: string;
};

async function waitForPromptDoneEvent(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  label: string,
): Promise<PromptDoneResult> {
  return await new Promise<PromptDoneResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    const events: PromptEvent[] = [];
    let settled = false;

    const finish = (run: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdoutData);
      child.stderr?.off("data", onStderrData);
      child.off("close", onClose);
      child.off("error", onError);
      run();
    };

    const parseLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return;
      }

      let event: PromptEvent;
      try {
        event = JSON.parse(trimmed) as PromptEvent;
      } catch {
        finish(() => {
          reject(
            new Error(
              `${label} emitted invalid JSON line: ${trimmed}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ),
          );
        });
        return;
      }

      events.push(event);
      if (event.result?.stopReason) {
        finish(() => {
          resolve({
            events,
            stdout,
            stderr,
          });
        });
      }
    };

    const flushLineBuffer = (): void => {
      const remainder = lineBuffer.trim();
      if (remainder.length > 0) {
        parseLine(remainder);
      }
      lineBuffer = "";
    };

    const onStdoutData = (chunk: string): void => {
      stdout += chunk;
      lineBuffer += chunk;

      for (;;) {
        const newline = lineBuffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = lineBuffer.slice(0, newline);
        lineBuffer = lineBuffer.slice(newline + 1);
        parseLine(line);
        if (settled) {
          return;
        }
      }
    };

    const onStderrData = (chunk: string): void => {
      stderr += chunk;
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      flushLineBuffer();
      if (settled) {
        return;
      }
      finish(() => {
        reject(
          new Error(
            `${label} exited before done event (code=${code}, signal=${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      });
    };

    const onError = (error: Error): void => {
      finish(() => reject(error));
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error(`${label} process timed out waiting for done event`));
      });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);
    child.on("close", onClose);
    child.on("error", onError);
  });
}

async function stopChildProcess(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGKILL");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not exit after SIGKILL within ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function listSleepPids(seconds: number): Promise<Set<number>> {
  const output = await runCommand("ps", ["-eo", "pid=,args="]);
  const pids = new Set<number>();
  const sleepPattern = new RegExp(`(^|\\s)sleep ${seconds}(\\s|$)`);

  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const commandLine = match[2].trim();
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }

    if (sleepPattern.test(commandLine)) {
      pids.add(pid);
    }
  }

  return pids;
}

async function assertNoNewSleepProcesses(
  baseline: Set<number>,
  seconds: number,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const current = await listSleepPids(seconds);
    const leaked = [...current].filter((pid) => !baseline.has(pid));
    if (leaked.length === 0) {
      return;
    }

    if (Date.now() >= deadline) {
      for (const pid of leaked) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // best-effort cleanup
        }
      }
      assert.fail(`Found orphan sleep process(es): ${leaked.join(", ")}`);
    }

    await sleep(100);
  }
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr}`));
    });
  });
}

function isProcessListUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EPERM";
}

function queueOwnerLockPath(homeDir: string, sessionId: string): string {
  const queueKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return path.join(homeDir, ".acpx", "queues", `${queueKey}.lock`);
}

async function staleQueueOwnerHeartbeat(homeDir: string, sessionId: string): Promise<void> {
  const lockPath = queueOwnerLockPath(homeDir, sessionId);
  const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as Record<string, unknown>;
  parsed.heartbeatAt = new Date(Date.now() - 10 * 60_000).toISOString();
  await fs.writeFile(lockPath, `${JSON.stringify(parsed)}\n`, "utf8");
}

async function readQueueOwnerLock(homeDir: string, sessionId: string): Promise<{ pid: number }> {
  const lockPath = queueOwnerLockPath(homeDir, sessionId);
  const payload = await fs.readFile(lockPath, "utf8");
  const parsed = JSON.parse(payload) as { pid?: unknown };
  const pid = Number(parsed.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`queue owner lock missing valid pid: ${payload}`);
  }
  return {
    pid,
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await sleep(50);
  }
  return !isPidAlive(pid);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("runPromptTurn: post-success drain runs before closing the turn", async () => {
  const calls: string[] = [];
  const client = {
    prompt: async () => {
      calls.push("prompt");
      return { stopReason: "end_turn" as const };
    },
    waitForSessionUpdatesIdle: async (options?: { idleMs?: number; timeoutMs?: number }) => {
      calls.push(`drain(${options?.idleMs ?? 0}/${options?.timeoutMs ?? 0})`);
    },
  };

  const conversation = createSessionConversation();
  const promptMessageId = recordPromptSubmission(conversation, "hello");
  const result = await runPromptTurn({
    client,
    sessionId: "session-under-test",
    prompt: "hello",
    conversation,
    promptMessageId,
  });

  assert.equal(result.source, "rpc");
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(
    calls,
    ["prompt", "drain(1000/5000)"],
    "post-success drain must run before runPromptTurn returns",
  );
});

test("runPromptTurn: prompt response usage is recorded after usage update drain", async () => {
  const conversation = createSessionConversation();
  const promptMessageId = recordPromptSubmission(conversation, "hello");
  assert.ok(promptMessageId);

  const client = {
    prompt: async () => ({
      stopReason: "end_turn" as const,
      usage: {
        inputTokens: 8,
        outputTokens: 1317,
        cachedReadTokens: 68370,
        cachedWriteTokens: 15156,
        thoughtTokens: 42,
        totalTokens: 84893,
      },
    }),
    waitForSessionUpdatesIdle: async () => {
      recordSessionUpdate(conversation, undefined, {
        sessionId: "session-response-usage",
        update: {
          sessionUpdate: "usage_update",
          used: 84,
          size: 1000,
        },
      });
    },
  };

  const result = await runPromptTurn({
    client,
    sessionId: "session-response-usage",
    prompt: "hello",
    conversation,
    promptMessageId,
  });

  assert.equal(result.source, "rpc");
  assert.deepEqual(conversation.cumulative_token_usage, {
    input_tokens: 8,
    output_tokens: 1317,
    cache_read_input_tokens: 68370,
    cache_creation_input_tokens: 15156,
    thought_tokens: 42,
    total_tokens: 84893,
  });
  assert.deepEqual(conversation.request_token_usage[promptMessageId], {
    input_tokens: 8,
    output_tokens: 1317,
    cache_read_input_tokens: 68370,
    cache_creation_input_tokens: 15156,
    thought_tokens: 42,
    total_tokens: 84893,
  });
});

test("runPromptTurn: successful prompt uses the bounded post-response settle window", async () => {
  const observed: string[] = [];
  let lateUpdateEmitted = false;
  const client = {
    prompt: async () => {
      observed.push("prompt-resolved");
      return { stopReason: "end_turn" as const };
    },
    waitForSessionUpdatesIdle: async (options?: { idleMs?: number; timeoutMs?: number }) => {
      lateUpdateEmitted = true;
      observed.push(`drain-completed(idle=${options?.idleMs ?? 0})`);
    },
  };

  const conversation = createSessionConversation();
  const promptMessageId = recordPromptSubmission(conversation, "hello");
  const result = await runPromptTurn({
    client,
    sessionId: "session-late-updates",
    prompt: "hello",
    conversation,
    promptMessageId,
  });

  assert.equal(result.source, "rpc");
  assert.equal(lateUpdateEmitted, true, "late session update must be consumed before turn closes");
  assert.deepEqual(observed, ["prompt-resolved", "drain-completed(idle=1000)"]);
});

test("runPromptTurn: an adaptive drain keeps ordinary one-shot completion short", async () => {
  const drainIdleMs: number[] = [];
  const result = await runPromptTurn({
    client: {
      prompt: async () => ({ stopReason: "end_turn" as const }),
      waitForSessionUpdatesIdle: async (options) => {
        drainIdleMs.push(options?.idleMs ?? 0);
      },
    },
    sessionId: "session-fast-drain",
    prompt: "hello",
    completionTracker: new TurnCompletionTracker(),
    initialDrainIdleMs: 100,
  });

  assert.deepEqual(drainIdleMs, [100]);
  assert.deepEqual(result, {
    status: "completed",
    stopReason: "end_turn",
    source: "rpc",
  });
});

test("runPromptTurn: an adaptive drain extends after a late compaction marker", async () => {
  const drainIdleMs: number[] = [];
  const tracker = new TurnCompletionTracker();
  const client = {
    prompt: async () => ({ stopReason: "end_turn" as const }),
    waitForSessionUpdatesIdle: async (options?: { idleMs?: number; timeoutMs?: number }) => {
      const idleMs = options?.idleMs ?? 0;
      drainIdleMs.push(idleMs);
      if (idleMs >= 100) {
        tracker.observe({
          sessionId: "session-compaction-grace",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "compact-1",
            status: "completed",
            _meta: { contextCompaction: true },
          },
        });
      }
    },
  };

  const result = await runPromptTurn({
    client,
    sessionId: "session-compaction-grace",
    prompt: "hello",
    completionTracker: tracker,
    initialDrainIdleMs: 100,
  });

  assert.deepEqual(drainIdleMs, [100, 1_000]);
  assert.deepEqual(result, {
    status: "incomplete",
    stopReason: "end_turn",
    reason: "context_compaction",
    source: "rpc",
  });
});

test("runPromptTurn: an adaptive drain accepts a final answer after a late marker", async () => {
  const drainIdleMs: number[] = [];
  const tracker = new TurnCompletionTracker();
  const client = {
    prompt: async () => ({ stopReason: "end_turn" as const }),
    waitForSessionUpdatesIdle: async (options?: { idleMs?: number }) => {
      const idleMs = options?.idleMs ?? 0;
      drainIdleMs.push(idleMs);
      if (drainIdleMs.length === 1) {
        tracker.observe({
          sessionId: "session-late-compaction-final",
          update: {
            sessionUpdate: "tool_call_update" as const,
            toolCallId: "compact-late-final",
            status: "completed" as const,
            _meta: { contextCompaction: true },
          },
        });
      } else {
        tracker.observe({
          sessionId: "session-late-compaction-final",
          update: {
            sessionUpdate: "agent_message_chunk" as const,
            content: { type: "text" as const, text: "late final verdict" },
            _meta: { codex: { phase: "final_answer" } },
          },
        });
      }
    },
  };

  const result = await runPromptTurn({
    client,
    sessionId: "session-late-compaction-final",
    prompt: "hello",
    completionTracker: tracker,
    initialDrainIdleMs: 100,
  });

  assert.deepEqual(drainIdleMs, [100, 1_000]);
  assert.deepEqual(result, {
    status: "completed",
    stopReason: "end_turn",
    source: "rpc",
  });
});

test("runPromptTurn: a known compaction goes straight to the full settle window", async () => {
  const drainIdleMs: number[] = [];
  const tracker = new TurnCompletionTracker();
  const client = {
    prompt: async () => {
      tracker.observe({
        sessionId: "session-compaction-final",
        update: {
          sessionUpdate: "tool_call_update" as const,
          toolCallId: "compact-1",
          status: "completed" as const,
          _meta: { contextCompaction: true },
        },
      });
      return { stopReason: "end_turn" as const };
    },
    waitForSessionUpdatesIdle: async (options?: { idleMs?: number }) => {
      const idleMs = options?.idleMs ?? 0;
      drainIdleMs.push(idleMs);
      if (idleMs >= 1_000) {
        tracker.observe({
          sessionId: "session-compaction-final",
          update: {
            sessionUpdate: "agent_message_chunk" as const,
            content: { type: "text" as const, text: "final verdict" },
            _meta: { codex: { phase: "final_answer" } },
          },
        });
      }
    },
  };

  assert.deepEqual(
    await runPromptTurn({
      client,
      sessionId: "session-compaction-final",
      prompt: "hello",
      completionTracker: tracker,
      initialDrainIdleMs: 100,
    }),
    { status: "completed", stopReason: "end_turn", source: "rpc" },
  );
  assert.deepEqual(drainIdleMs, [1_000]);
});

test("runPromptTurn: a one-shot timeout does not add an unsalvageable reply drain", async () => {
  const drainIdleMs: number[] = [];
  const tracker = new TurnCompletionTracker();

  await assert.rejects(
    async () =>
      await runPromptTurn({
        client: {
          prompt: async () => await new Promise<never>(() => {}),
          waitForSessionUpdatesIdle: async (options) => {
            drainIdleMs.push(options?.idleMs ?? 0);
          },
        },
        sessionId: "session-one-shot-timeout",
        prompt: "hello",
        timeoutMs: 1,
        completionTracker: tracker,
        initialDrainIdleMs: 100,
      }),
    /Timed out after 1ms/,
  );

  assert.deepEqual(drainIdleMs, []);
  assert.equal(tracker.hasUnansweredCompaction(), false);
});

test("runPromptTurn: missing waitForSessionUpdatesIdle still returns cleanly on success", async () => {
  const client = {
    prompt: async () => ({ stopReason: "end_turn" as const }),
  };

  const conversation = createSessionConversation();
  const promptMessageId = recordPromptSubmission(conversation, "hello");
  const result = await runPromptTurn({
    client,
    sessionId: "session-no-drain",
    prompt: "hello",
    conversation,
    promptMessageId,
  });

  assert.equal(result.source, "rpc");
  assert.equal(result.stopReason, "end_turn");
});

test("runPromptTurn: existing agent reply still allows post-success drain", async () => {
  const calls: string[] = [];
  const conversation = createSessionConversation();
  const promptMessageId = recordPromptSubmission(conversation, "hello");
  assert.ok(promptMessageId);
  recordSessionUpdate(conversation, undefined, {
    sessionId: "session-existing-reply",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "already visible" },
    },
  });
  const client = {
    prompt: async () => {
      calls.push("prompt");
      return { stopReason: "end_turn" as const };
    },
    waitForSessionUpdatesIdle: async () => {
      calls.push("drain");
    },
  };

  const result = await runPromptTurn({
    client,
    sessionId: "session-existing-reply",
    prompt: "hello",
    conversation,
    promptMessageId,
  });

  assert.equal(result.source, "rpc");
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(calls, ["prompt", "drain"]);
});

type StoredPendingRequest = {
  request_id: string;
  kind?: string;
  state: string;
  task_request_id: string;
  elicitation?: { message?: string; mode?: string; requested_schema?: unknown };
  resolution?: { source?: string; option_id?: string; action?: string };
};

async function readStoredPendingRequests(homeDir: string): Promise<StoredPendingRequest[]> {
  const base = path.join(homeDir, ".acpx", "requests");
  const entries: StoredPendingRequest[] = [];
  let sessionDirs: string[];
  try {
    sessionDirs = await fs.readdir(base);
  } catch {
    return entries;
  }
  for (const dir of sessionDirs) {
    for (const name of await fs.readdir(path.join(base, dir))) {
      if (!name.endsWith(".json")) {
        continue;
      }
      entries.push(
        JSON.parse(await fs.readFile(path.join(base, dir, name), "utf8")) as (typeof entries)[0],
      );
    }
  }
  return entries;
}

async function readAcpxExtensionMethods(homeDir: string): Promise<string[]> {
  const sessionsDir = path.join(homeDir, ".acpx", "sessions");
  const methods: string[] = [];
  for (const name of await fs.readdir(sessionsDir)) {
    if (!name.endsWith(".stream.ndjson")) {
      continue;
    }
    const contents = await fs.readFile(path.join(sessionsDir, name), "utf8");
    for (const line of contents.split("\n")) {
      const match = /"method":"(_acpx\/[a-z_]+)"/.exec(line);
      if (match?.[1]) {
        methods.push(match[1]);
      }
    }
  }
  return methods;
}

test("integration: --defer parks a deferred permission and expiry resolves it", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    try {
      const created = await runCli(
        [...baseAgentArgs(cwd), "--format", "json", "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);

      const result = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--defer",
          "--defer-max-age",
          "1",
          "--policy",
          '{"defaultAction":"defer"}',
          "--format",
          "json",
          "--ttl",
          "20",
          "prompt",
          "permission execute Bash",
        ],
        homeDir,
        { timeoutMs: 30_000 },
      );

      assert.equal(result.code, 5, result.stderr);
      assert.match(result.stdout, /"outcome":"selected","optionId":"reject"/);

      const stored = await readStoredPendingRequests(homeDir);
      assert.equal(stored.length, 1, JSON.stringify(stored));
      assert.equal(stored[0]?.state, "expired");
      assert.equal(stored[0]?.resolution?.source, "expiry");
      assert.equal(stored[0]?.resolution?.option_id, "reject");

      const methods = await readAcpxExtensionMethods(homeDir);
      assert.equal(
        methods.filter((method) => method === "_acpx/pending_request").length >= 2,
        true,
        `expected created+expired notifications, got ${JSON.stringify(methods)}`,
      );

      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "close"], homeDir);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: a no-wait deferred permission still reaches the event log", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    try {
      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "new"], homeDir);

      // --no-wait discards the formatter, so the durable event log is the only
      // place these transitions can surface.
      const submitted = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--defer",
          "--defer-max-age",
          "1",
          "--policy",
          '{"defaultAction":"defer"}',
          "--format",
          "json",
          "--ttl",
          "20",
          "prompt",
          "--no-wait",
          "permission execute Bash",
        ],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(submitted.code, 0, submitted.stderr);

      const deadline = Date.now() + 25_000;
      let stored = await readStoredPendingRequests(homeDir);
      while (stored[0]?.state !== "expired" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        stored = await readStoredPendingRequests(homeDir);
      }

      assert.equal(stored.length, 1, JSON.stringify(stored));
      assert.equal(stored[0]?.state, "expired");
      assert.equal((stored[0]?.task_request_id ?? "").length > 0, true);

      // The store is written synchronously by the manager, but the event log is
      // batched and flushed at turn checkpoints, so it needs its own wait.
      let methods = await readAcpxExtensionMethods(homeDir);
      while (!methods.includes("_acpx/pending_request") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        methods = await readAcpxExtensionMethods(homeDir);
      }
      assert.equal(
        methods.includes("_acpx/pending_request"),
        true,
        `expected pending-request notifications, got ${JSON.stringify(methods)}`,
      );

      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "close"], homeDir);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: without --defer a defer policy still degrades to deny plus event", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    try {
      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "new"], homeDir);

      const result = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--policy",
          '{"defaultAction":"defer"}',
          "--format",
          "json",
          "--ttl",
          "20",
          "prompt",
          "permission execute Bash",
        ],
        homeDir,
        { timeoutMs: 30_000 },
      );

      assert.equal(result.code, 5, result.stderr);
      assert.match(result.stdout, /"outcome":"selected","optionId":"reject"/);
      assert.match(result.stdout, /"action":"defer"/);
      // Nothing is parked without the opt-in.
      assert.deepEqual(await readStoredPendingRequests(homeDir), []);

      const methods = await readAcpxExtensionMethods(homeDir);
      assert.equal(methods.includes("_acpx/permission_escalation"), true);
      assert.equal(methods.includes("_acpx/pending_request"), false);

      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "close"], homeDir);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: a warm non-parking owner refuses a --defer submit", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    try {
      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "new"], homeDir);
      // Warm an owner WITHOUT --defer; it cannot park anything.
      const warm = await runCli(
        [...baseAgentArgs(cwd), "--format", "quiet", "--ttl", "30", "prompt", "hello"],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(warm.code, 0, warm.stderr);

      const deferred = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--defer",
          "--defer-max-age",
          "1",
          "--policy",
          '{"defaultAction":"defer"}',
          "--format",
          "json",
          "--ttl",
          "30",
          "prompt",
          "permission execute Bash",
        ],
        homeDir,
        { timeoutMs: 30_000 },
      );

      // Must be refused, not silently denied: a plain denial is
      // indistinguishable from parked-then-expired.
      assert.notEqual(deferred.code, 5, deferred.stdout);
      assert.match(`${deferred.stdout}${deferred.stderr}`, /cannot park deferred requests/);
      assert.deepEqual(await readStoredPendingRequests(homeDir), []);

      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "close"], homeDir);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: cancelling a session unwinds a parked permission request", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const deferArgs = [...baseAgentArgs(cwd), "--defer", "--defer-max-age", "0"];
    try {
      await runCli([...deferArgs, "--format", "json", "sessions", "new"], homeDir);

      // max-age 0 parks indefinitely, so only the cancel can settle this.
      const submitted = await runCli(
        [
          ...deferArgs,
          "--policy",
          '{"defaultAction":"defer"}',
          "--format",
          "json",
          "--ttl",
          "30",
          "prompt",
          "--no-wait",
          "permission execute Bash",
        ],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(submitted.code, 0, submitted.stderr);

      const deadline = Date.now() + 25_000;
      let stored = await readStoredPendingRequests(homeDir);
      while (stored[0]?.state !== "pending" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        stored = await readStoredPendingRequests(homeDir);
      }
      assert.equal(stored[0]?.state, "pending", JSON.stringify(stored));

      // IPC cancel -> turn controller -> AbortSignal -> attachAbort.
      const cancelled = await runCli([...deferArgs, "--format", "json", "cancel"], homeDir, {
        timeoutMs: 30_000,
      });
      assert.equal(cancelled.code, 0, cancelled.stderr);

      while (stored[0]?.state === "pending" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        stored = await readStoredPendingRequests(homeDir);
      }
      assert.equal(stored[0]?.state, "cancelled", JSON.stringify(stored));
      assert.equal(stored[0]?.resolution?.source, "cancel");

      await runCli([...deferArgs, "--format", "json", "sessions", "close"], homeDir);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

type ParkedRequestFixture = {
  homeDir: string;
  cwd: string;
  deferArgs: string[];
  sessionId: string;
};

/**
 * A session with one permission request parked and nothing able to settle it
 * but a responder: `--defer-max-age 0` never expires, and `--no-wait` returns
 * while the turn stays blocked on the park.
 */
async function withParkedRequest(
  run: (fixture: ParkedRequestFixture) => Promise<void>,
  parkPrompt = "permission execute Bash",
): Promise<void> {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    const deferArgs = [...baseAgentArgs(cwd), "--defer", "--defer-max-age", "0"];
    try {
      const created = await runCli([...deferArgs, "--format", "json", "sessions", "new"], homeDir);
      assert.equal(created.code, 0, created.stderr);
      const sessionId = (JSON.parse(created.stdout.trim()) as { acpxRecordId: string })
        .acpxRecordId;

      await parkPermissionRequest(homeDir, deferArgs, parkPrompt);
      await run({ homeDir, cwd, deferArgs, sessionId });
    } finally {
      await runCli([...deferArgs, "--format", "json", "sessions", "close"], homeDir).catch(
        () => undefined,
      );
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
}

async function parkPermissionRequest(
  homeDir: string,
  deferArgs: string[],
  parkPrompt: string,
): Promise<void> {
  const submitted = await runCli(
    [
      ...deferArgs,
      "--policy",
      '{"defaultAction":"defer"}',
      "--format",
      "json",
      "--ttl",
      "60",
      "prompt",
      "--no-wait",
      parkPrompt,
    ],
    homeDir,
    { timeoutMs: 30_000 },
  );
  assert.equal(submitted.code, 0, submitted.stderr);
  await waitForParkedRequest(homeDir);
}

async function listRequestsJson(
  homeDir: string,
  args: string[],
  extra: string[] = [],
): Promise<Array<Record<string, unknown>>> {
  const listed = await runCli([...args, "requests", "--json", ...extra], homeDir);
  assert.equal(listed.code, 0, `${listed.stdout}${listed.stderr}`);
  return JSON.parse(listed.stdout.trim()) as Array<Record<string, unknown>>;
}

async function waitForParkedRequest(homeDir: string): Promise<StoredPendingRequest> {
  return await waitFor(async () => {
    const stored = await readStoredPendingRequests(homeDir);
    return stored.find((entry) => entry.state === "pending") ?? null;
  }, 25_000);
}

async function waitForRequestState(homeDir: string, state: string): Promise<void> {
  await waitFor(async () => {
    const stored = await readStoredPendingRequests(homeDir);
    return stored.some((entry) => entry.state === state) ? state : null;
  }, 25_000);
}

async function readPendingRequestEvents(
  homeDir: string,
): Promise<Array<{ event: string; state: string }>> {
  const sessionsDir = path.join(homeDir, ".acpx", "sessions");
  const events: Array<{ event: string; state: string }> = [];
  for (const name of await fs.readdir(sessionsDir)) {
    if (!name.endsWith(".stream.ndjson")) {
      continue;
    }
    const contents = await fs.readFile(path.join(sessionsDir, name), "utf8");
    for (const line of contents.split("\n")) {
      if (!line.includes('"_acpx/pending_request"')) {
        continue;
      }
      const parsed = JSON.parse(line) as {
        params?: { event?: string; request?: { state?: string } };
      };
      events.push({
        event: parsed.params?.event ?? "",
        state: parsed.params?.request?.state ?? "",
      });
    }
  }
  return events;
}

/** The content the mock agent echoed back from an accepted elicitation. */
async function readAcceptedElicitationContent(homeDir: string): Promise<string | undefined> {
  const unescaped = (await readSessionStream(homeDir)).replaceAll('\\"', '"');
  return /elicitation accepted:(\{[^}]*\})/.exec(unescaped)?.[1];
}

async function readSessionStream(homeDir: string): Promise<string> {
  const sessionsDir = path.join(homeDir, ".acpx", "sessions");
  let contents = "";
  for (const name of await fs.readdir(sessionsDir)) {
    if (name.endsWith(".stream.ndjson")) {
      contents += await fs.readFile(path.join(sessionsDir, name), "utf8");
    }
  }
  return contents;
}

test("integration: requests list shows a parked request and respond --option settles it", async () => {
  await withParkedRequest(async ({ homeDir, deferArgs }) => {
    const listed = await listRequestsJson(homeDir, deferArgs);
    assert.equal(listed.length, 1, JSON.stringify(listed));
    const parked = listed[0] ?? {};
    // The listing is the persisted store shape, verbatim: snake_case, schema
    // included, and the agent's full option list so a responder can echo an id.
    assert.equal(parked.schema, "acpx.pending_request.v1");
    assert.equal(parked.state, "pending");
    assert.deepEqual(parked.options, [
      { option_id: "allow", name: "Allow", kind: "allow_once" },
      { option_id: "reject", name: "Reject", kind: "reject_once" },
    ]);
    const requestId = String(parked.request_id);

    const answered = await runCli(
      [...deferArgs, "--format", "json", "respond", requestId, "--option", "allow"],
      homeDir,
      { timeoutMs: 30_000 },
    );
    assert.equal(answered.code, 0, `${answered.stdout}${answered.stderr}`);
    const answeredPayload = JSON.parse(answered.stdout.trim()) as {
      state: string;
      resolution?: { source?: string; option_id?: string };
    };
    assert.equal(answeredPayload.state, "answered");
    assert.equal(answeredPayload.resolution?.source, "cli");
    assert.equal(answeredPayload.resolution?.option_id, "allow");

    const stored = await readStoredPendingRequests(homeDir);
    assert.equal(stored[0]?.state, "answered");
    assert.equal(stored[0]?.resolution?.source, "cli");
    assert.equal(stored[0]?.resolution?.option_id, "allow");

    // The parked turn resumes with the selected option and runs to completion.
    await waitFor(async () => {
      const stream = await readSessionStream(homeDir);
      return stream.includes("permission selected:allow") ? "done" : null;
    }, 25_000);

    const events = await readPendingRequestEvents(homeDir);
    assert.deepEqual(
      events.map((entry) => `${entry.event}:${entry.state}`),
      ["created:pending", "answered:answered"],
    );

    // A settled request is a usage error, not a silent no-op.
    const again = await runCli([...deferArgs, "respond", requestId, "--option", "allow"], homeDir, {
      timeoutMs: 30_000,
    });
    assert.equal(again.code, 2, `${again.stdout}${again.stderr}`);
    assert.match(`${again.stdout}${again.stderr}`, /No pending request/);
  });
});

test("integration: respond --decline answers with the agent's rejection option", async () => {
  await withParkedRequest(async ({ homeDir, deferArgs }) => {
    const requestId = String((await listRequestsJson(homeDir, deferArgs))[0]?.request_id);

    const declined = await runCli(
      [...deferArgs, "--format", "json", "respond", requestId, "--decline"],
      homeDir,
      { timeoutMs: 30_000 },
    );
    assert.equal(declined.code, 0, `${declined.stdout}${declined.stderr}`);
    const payload = JSON.parse(declined.stdout.trim()) as {
      state: string;
      resolution?: { source?: string; option_id?: string };
    };
    assert.equal(payload.state, "answered");
    assert.equal(payload.resolution?.option_id, "reject");
    assert.equal(payload.resolution?.source, "cli");

    await waitFor(async () => {
      const stream = await readSessionStream(homeDir);
      return stream.includes("permission selected:reject") ? "done" : null;
    }, 25_000);
  });
});

test("integration: respond --cancel unblocks the turn without choosing an option", async () => {
  await withParkedRequest(async ({ homeDir, deferArgs }) => {
    const requestId = String((await listRequestsJson(homeDir, deferArgs))[0]?.request_id);

    const cancelled = await runCli(
      [...deferArgs, "--format", "json", "respond", requestId, "--cancel"],
      homeDir,
      { timeoutMs: 30_000 },
    );
    assert.equal(cancelled.code, 0, `${cancelled.stdout}${cancelled.stderr}`);
    const payload = JSON.parse(cancelled.stdout.trim()) as {
      state: string;
      resolution?: { source?: string; option_id?: string };
    };
    // `cli` is what separates an operator cancel from a turn or shutdown one.
    assert.equal(payload.state, "cancelled");
    assert.equal(payload.resolution?.source, "cli");
    assert.equal(payload.resolution?.option_id, undefined);

    await waitFor(async () => {
      const stream = await readSessionStream(homeDir);
      return stream.includes("permission cancelled") ? "done" : null;
    }, 25_000);
  });
});

test("integration: respond refuses exactly-one-answer violations before touching the store", async () => {
  await withParkedRequest(async ({ homeDir, deferArgs }) => {
    const requestId = String((await listRequestsJson(homeDir, deferArgs))[0]?.request_id);

    for (const args of [
      ["respond", requestId],
      ["respond", requestId, "--decline", "--cancel"],
      ["respond", requestId, "--option", "allow", "--decline"],
    ]) {
      const result = await runCli([...deferArgs, ...args], homeDir, { timeoutMs: 30_000 });
      assert.equal(result.code, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    }

    // Commander rejects these before the handler runs; they are still usage
    // errors, not the exit code acpx reserves for delivery failures.
    for (const args of [
      ["respond", "", "--option", "allow"],
      ["respond", requestId, "--option", ""],
      ["requests", "--nope"],
    ]) {
      const result = await runCli([...deferArgs, ...args], homeDir, { timeoutMs: 30_000 });
      assert.equal(result.code, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    }

    const jsonUsage = await runCli(
      [...deferArgs, "--format", "json", "respond", requestId, "--option", ""],
      homeDir,
      { timeoutMs: 30_000 },
    );
    assert.equal(jsonUsage.code, 2, `${jsonUsage.stdout}${jsonUsage.stderr}`);
    assert.equal(
      (
        JSON.parse(jsonUsage.stdout.trim()) as {
          error: { data: { acpxCode: string } };
        }
      ).error.data.acpxCode,
      "USAGE",
      jsonUsage.stdout,
    );

    const unknownOption = await runCli(
      [...deferArgs, "respond", requestId, "--option", "not-offered"],
      homeDir,
      { timeoutMs: 30_000 },
    );
    assert.equal(unknownOption.code, 2, `${unknownOption.stdout}${unknownOption.stderr}`);
    // The message has to name what the agent actually offered.
    assert.match(`${unknownOption.stdout}${unknownOption.stderr}`, /offered: allow, reject/);

    // Every refusal above left the request answerable.
    assert.equal((await readStoredPendingRequests(homeDir))[0]?.state, "pending");
  });
});

test("integration: requests list surfaces a park whose durable record is missing", async () => {
  await withParkedRequest(async ({ homeDir, deferArgs }) => {
    const requestsDir = path.join(homeDir, ".acpx", "requests");
    const sessionDir = path.join(requestsDir, (await fs.readdir(requestsDir))[0] ?? "");
    const files = await fs.readdir(sessionDir);
    assert.equal(files.length, 1, files.join(", "));
    // Stand in for the documented failure mode the manager tolerates: the owner
    // is blocked on this request but its durable write did not land.
    await fs.rm(path.join(sessionDir, files[0] ?? ""));
    assert.deepEqual(await readStoredPendingRequests(homeDir), []);

    const listed = await listRequestsJson(homeDir, deferArgs);
    assert.equal(listed.length, 1, listed.length === 0 ? "live park was not listed" : "");
    assert.equal(listed[0]?.state, "pending");
    const requestId = String(listed[0]?.request_id);

    // And it is still answerable: the owner, not the store, is what holds it.
    const answered = await runCli(
      [...deferArgs, "--format", "json", "respond", requestId, "--option", "allow"],
      homeDir,
      { timeoutMs: 30_000 },
    );
    assert.equal(answered.code, 0, `${answered.stdout}${answered.stderr}`);
  });
});

test("integration: respond --decline is refused when the agent offered no rejection", async () => {
  await withParkedRequest(async ({ homeDir, deferArgs }) => {
    const listed = await listRequestsJson(homeDir, deferArgs);
    assert.deepEqual(listed[0]?.options, [
      { option_id: "allow", name: "Allow", kind: "allow_once" },
    ]);
    const requestId = String(listed[0]?.request_id);

    const declined = await runCli([...deferArgs, "respond", requestId, "--decline"], homeDir, {
      timeoutMs: 30_000,
    });
    // Turning this into a cancel would report an outcome the agent never
    // offered, so it is refused and the responder is told what it can send.
    assert.equal(declined.code, 2, `${declined.stdout}${declined.stderr}`);
    assert.match(
      `${declined.stdout}${declined.stderr}`,
      /offers no rejection option to decline with.*offered: allow/s,
    );
    assert.equal((await readStoredPendingRequests(homeDir))[0]?.state, "pending");

    const cancelled = await runCli(
      [...deferArgs, "--format", "json", "respond", requestId, "--cancel"],
      homeDir,
      { timeoutMs: 30_000 },
    );
    assert.equal(cancelled.code, 0, `${cancelled.stdout}${cancelled.stderr}`);
    assert.equal((JSON.parse(cancelled.stdout.trim()) as { state: string }).state, "cancelled");
  }, 'permission-options [{"optionId":"allow","name":"Allow","kind":"allow_once"}] Bash');
});

test("integration: inspecting a session never retires a live queue owner", async () => {
  await withParkedRequest(async ({ homeDir, deferArgs, sessionId }) => {
    const { pid } = await readQueueOwnerLock(homeDir, sessionId);
    // Suspend the owner and backdate its heartbeat: alive, holding the parked
    // promise, and indistinguishable from dead to a staleness check.
    process.kill(pid, "SIGSTOP");
    try {
      await staleQueueOwnerHeartbeat(homeDir, sessionId);

      const listed = await runCli([...deferArgs, "requests", "--json"], homeDir, {
        timeoutMs: 30_000,
      });
      assert.equal(listed.code, 0, `${listed.stdout}${listed.stderr}`);
      // The store still answers, and the unreachable owner is reported rather
      // than passed off as an empty live view.
      assert.equal(
        (JSON.parse(listed.stdout.trim()) as Array<{ state: string }>)[0]?.state,
        "pending",
        listed.stdout,
      );
      assert.match(listed.stderr, /"method":"_acpx\/warning"/);

      const listedAll = await runCli([...deferArgs, "requests", "--json", "--all"], homeDir, {
        timeoutMs: 30_000,
      });
      assert.equal(listedAll.code, 0, `${listedAll.stdout}${listedAll.stderr}`);

      // --json-strict suppresses non-JSON stderr; it must not suppress the one
      // diagnostic that says this listing may be short, since a machine
      // consumer cannot notice that on its own.
      const strict = await runCli(
        [...deferArgs, "--format", "json", "--json-strict", "requests"],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(strict.code, 0, `${strict.stdout}${strict.stderr}`);
      assert.deepEqual(
        (JSON.parse(strict.stderr.trim()) as { method: string; params: { code: string } }).params
          .code,
        "QUEUE_OWNER_UNREACHABLE",
        strict.stderr,
      );

      // status is an inspection surface too, and it reports the parked count,
      // so it must not retire the owner holding those requests either.
      const status = await runCli([...deferArgs, "--format", "json", "status"], homeDir, {
        timeoutMs: 30_000,
      });
      assert.equal(status.code, 0, `${status.stdout}${status.stderr}`);
      const statusPayload = JSON.parse(status.stdout.trim()) as {
        status: string;
        summary: string;
        parkedRequests: number;
      };
      // Honest about what it could not do: the process is alive, so this is
      // neither "running" nor "dead".
      assert.equal(statusPayload.status, "unreachable", status.stdout);
      assert.equal(statusPayload.summary, "queue owner is running but not answering");
      assert.equal(statusPayload.parkedRequests, 1);

      // The owner is still running and the park is still answerable: an
      // inspection command must not kill what it is inspecting, and must not
      // orphan requests whose answers are still coming.
      assert.equal(isPidAlive(pid), true, "inspection retired a live queue owner");
      assert.equal((await readStoredPendingRequests(homeDir))[0]?.state, "pending");
    } finally {
      process.kill(pid, "SIGCONT");
    }

    // And the resumed owner can still answer it.
    const requestId = (await readStoredPendingRequests(homeDir))[0]?.request_id ?? "";
    const answered = await runCli(
      [...deferArgs, "--format", "json", "respond", requestId, "--option", "allow"],
      homeDir,
      { timeoutMs: 30_000 },
    );
    assert.equal(answered.code, 0, `${answered.stdout}${answered.stderr}`);
  });
});

test("integration: respond --timeout gives up on an owner that cannot answer", async () => {
  await withParkedRequest(async ({ homeDir, deferArgs, sessionId }) => {
    const requestId = (await readStoredPendingRequests(homeDir))[0]?.request_id ?? "";
    const { pid } = await readQueueOwnerLock(homeDir, sessionId);
    process.kill(pid, "SIGSTOP");
    try {
      const timedOut = await runCli(
        [...deferArgs, "--format", "json", "--timeout", "1", "respond", requestId, "--cancel"],
        homeDir,
        { timeoutMs: 30_000 },
      );

      // Exit 3 is what --timeout means everywhere else in the CLI, and the
      // detail code separates "I stopped waiting" from "delivery failed".
      assert.equal(timedOut.code, 3, `${timedOut.stdout}${timedOut.stderr}`);
      const payload = JSON.parse(timedOut.stdout.trim()) as {
        error: { data: { acpxCode: string; detailCode: string } };
      };
      assert.equal(payload.error.data.acpxCode, "TIMEOUT");
      assert.equal(payload.error.data.detailCode, "PENDING_REQUEST_ANSWER_TIMEOUT");
      assert.match(timedOut.stdout, /may still be applied/);

      // Giving up is not the same as deciding the request is unanswerable.
      assert.equal(isPidAlive(pid), true);
      assert.equal((await readStoredPendingRequests(homeDir))[0]?.state, "pending");
    } finally {
      process.kill(pid, "SIGCONT");
    }

    // "May still be applied" is not a hedge: the resumed owner applies the
    // answer that was already on the wire, so the request settles from the very
    // call that reported a timeout, and a second attempt finds it settled.
    await waitForRequestState(homeDir, "cancelled");
    assert.equal((await readStoredPendingRequests(homeDir))[0]?.resolution?.source, "cli");

    const again = await runCli([...deferArgs, "respond", requestId, "--cancel"], homeDir, {
      timeoutMs: 30_000,
    });
    assert.equal(again.code, 2, `${again.stdout}${again.stderr}`);
  });
});

/**
 * Saturate a suspended owner's listen backlog.
 *
 * A SIGSTOPped process still has connects completed for it by the kernel, up to
 * the backlog depth — which is why the plain suspended-owner case connects fine
 * and only the reply never comes. Once the backlog is full the kernel refuses
 * instead, and ECONNREFUSED is exactly what the connect retry loop retries. This
 * is the shape a genuinely wedged owner has, and the shape under which a bound
 * armed after the connect is no bound at all.
 */
async function holdQueueOwnerBacklog(
  socketPath: string,
  count = 400,
): Promise<() => Promise<void>> {
  const held: net.Socket[] = [];
  for (let index = 0; index < count; index += 1) {
    const socket = net.createConnection(socketPath);
    // A refused connect is the point of the exercise, not a test failure.
    socket.on("error", () => {});
    held.push(socket);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  return async () => {
    for (const socket of held) {
      socket.destroy();
    }
  };
}

test("integration: respond --timeout holds its budget when the owner cannot be connected to", async () => {
  await withParkedRequest(async ({ homeDir, deferArgs, sessionId }) => {
    const requestId = (await readStoredPendingRequests(homeDir))[0]?.request_id ?? "";
    const { pid } = await readQueueOwnerLock(homeDir, sessionId);
    const { socketPath } = queuePaths(homeDir, sessionId);
    process.kill(pid, "SIGSTOP");
    const release = await holdQueueOwnerBacklog(socketPath);
    try {
      const startedAt = Date.now();
      const timedOut = await runCli(
        [...deferArgs, "--format", "json", "--timeout", "0.3", "respond", requestId, "--cancel"],
        homeDir,
        { timeoutMs: 30_000 },
      );
      const elapsedMs = Date.now() - startedAt;

      // The same answer the reply-phase timeout gives: giving up is a timeout
      // whichever phase ran out of budget, and it keeps its own exit code
      // rather than degrading into a generic delivery failure.
      assert.equal(timedOut.code, 3, `${timedOut.stdout}${timedOut.stderr}`);
      const payload = JSON.parse(timedOut.stdout.trim()) as {
        error: { data: { acpxCode: string; detailCode: string } };
      };
      assert.equal(payload.error.data.acpxCode, "TIMEOUT");
      assert.equal(payload.error.data.detailCode, "PENDING_REQUEST_ANSWER_TIMEOUT");
      // The connect retry loop is 40 attempts x 50 ms, so an unbounded connect
      // cannot come back before ~2 s however small the asked-for budget is.
      assert.equal(
        elapsedMs < 2_000,
        true,
        `respond took ${elapsedMs}ms against a 300ms bound: ${timedOut.stdout}`,
      );

      assert.equal(isPidAlive(pid), true);
      assert.equal((await readStoredPendingRequests(homeDir))[0]?.state, "pending");
    } finally {
      await release();
      process.kill(pid, "SIGCONT");
    }

    // Nothing was ever written to the owner, so unlike the reply-phase timeout
    // there is no answer in flight to land later: the request is still parked
    // and still answerable.
    const answered = await runCli(
      [...deferArgs, "--format", "json", "respond", requestId, "--cancel"],
      homeDir,
      { timeoutMs: 30_000 },
    );
    assert.equal(answered.code, 0, `${answered.stdout}${answered.stderr}`);
  });
});

test("integration: status reports parked requests, and a dead owner orphans them", async () => {
  await withParkedRequest(async ({ homeDir, deferArgs, sessionId }) => {
    const parkedStatus = await runCli([...deferArgs, "--format", "json", "status"], homeDir);
    assert.equal(parkedStatus.code, 0, parkedStatus.stderr);
    assert.equal(
      (JSON.parse(parkedStatus.stdout.trim()) as { parkedRequests?: number }).parkedRequests,
      1,
      parkedStatus.stdout,
    );

    const { pid } = await readQueueOwnerLock(homeDir, sessionId);
    process.kill(pid, "SIGKILL");
    assert.equal(await waitForPidExit(pid, 5_000), true);

    // The count is read from the durable store, so it survives the owner that
    // wrote it — which is exactly when an operator needs to see it.
    const deadStatus = await runCli([...deferArgs, "--format", "json", "status"], homeDir);
    assert.equal(
      (JSON.parse(deadStatus.stdout.trim()) as { parkedRequests?: number }).parkedRequests,
      1,
      deadStatus.stdout,
    );
    const quietStatus = await runCli([...deferArgs, "--format", "quiet", "status"], homeDir);
    assert.match(quietStatus.stdout, /parked:1/);

    const requestId = (await readStoredPendingRequests(homeDir))[0]?.request_id ?? "";
    const answered = await runCli(
      [...deferArgs, "respond", requestId, "--option", "allow"],
      homeDir,
      { timeoutMs: 30_000 },
    );
    // Nothing can answer a request whose waiter died with its owner, and the
    // refusal names that as the reason rather than reporting a failed delivery.
    assert.equal(answered.code, 4, `${answered.stdout}${answered.stderr}`);
    assert.match(
      `${answered.stdout}${answered.stderr}`,
      /can no longer be answered: its queue owner is no longer running/,
    );

    const listed = await listRequestsJson(homeDir, deferArgs);
    assert.equal(listed[0]?.state, "orphaned", JSON.stringify(listed));
    const afterOrphan = await runCli([...deferArgs, "--format", "json", "status"], homeDir);
    assert.equal(
      (JSON.parse(afterOrphan.stdout.trim()) as { parkedRequests?: number }).parkedRequests,
      0,
      afterOrphan.stdout,
    );
  });
});

test("integration: requests --all lists parked requests without a session in cwd", async () => {
  await withParkedRequest(async ({ homeDir, deferArgs }) => {
    const otherCwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-elsewhere-"));
    try {
      const scoped = await runCli([...baseAgentArgs(otherCwd), "requests", "--json"], homeDir);
      // No session here: the cwd-scoped listing says so instead of reporting an
      // empty list that looks like "nothing is parked".
      assert.equal(scoped.code, 4, `${scoped.stdout}${scoped.stderr}`);

      const all = await runCli(
        [...baseAgentArgs(otherCwd), "requests", "--json", "--all"],
        homeDir,
      );
      assert.equal(all.code, 0, `${all.stdout}${all.stderr}`);
      const entries = JSON.parse(all.stdout.trim()) as Array<{ state: string }>;
      assert.equal(entries.length, 1, all.stdout);
      assert.equal(entries[0]?.state, "pending");

      const conflicting = await runCli(
        [...baseAgentArgs(otherCwd), "requests", "--all", "-s", "somewhere"],
        homeDir,
      );
      // Naming a session while asking for all of them is contradictory.
      assert.equal(conflicting.code, 2, `${conflicting.stdout}${conflicting.stderr}`);
      assert.match(`${conflicting.stdout}${conflicting.stderr}`, /--all cannot be combined/);

      await runCli([...deferArgs, "--format", "json", "cancel"], homeDir, { timeoutMs: 30_000 });
      await waitForRequestState(homeDir, "cancelled");
    } finally {
      await fs.rm(otherCwd, { recursive: true, force: true });
    }
  });
});

/**
 * The AskUserQuestion form claude-agent-acp actually builds, in miniature: a
 * titled `oneOf` enum whose `const` is the option label, plus the per-question
 * free-text field it always pairs with it.
 */
const ASK_USER_QUESTION_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    question_0: {
      type: "string",
      title: "Greeting",
      oneOf: [
        { const: "Greeting A", title: "Greeting A" },
        { const: "Greeting B", title: "Greeting B" },
      ],
    },
    question_0_custom: { type: "string", title: "Other" },
  },
});

function elicitPrompt(schemaJson = ASK_USER_QUESTION_SCHEMA, message = "Which greeting?"): string {
  return `elicit ${schemaJson} ${message}`;
}

/** A session with one elicitation parked and nothing but a responder to settle it. */
async function withParkedElicitation(
  run: (fixture: ParkedRequestFixture) => Promise<void>,
  parkPrompt = elicitPrompt(),
): Promise<void> {
  await withParkedRequest(run, parkPrompt);
}

test("integration: an elicitation parks, lists with its form, and --field answers it", async () => {
  await withParkedElicitation(async ({ homeDir, deferArgs }) => {
    const listed = await listRequestsJson(homeDir, deferArgs);
    assert.equal(listed.length, 1, JSON.stringify(listed));
    const parked = listed[0] ?? {};
    assert.equal(parked.schema, "acpx.pending_request.v1");
    assert.equal(parked.kind, "elicitation");
    assert.equal(parked.state, "pending");
    // Nothing to pick from, so the option list is empty rather than absent:
    // one shape for both kinds on disk, on the wire and in this listing.
    assert.deepEqual(parked.options, []);
    const elicitation = parked.elicitation as {
      message?: string;
      mode?: string;
      tool_call_id?: string;
      requested_schema?: unknown;
    };
    assert.equal(elicitation.message, "Which greeting?");
    assert.equal(elicitation.mode, "form");
    assert.equal(elicitation.tool_call_id, "ask-1");
    // The agent's schema, verbatim: it is what the answer is typed against.
    assert.deepEqual(elicitation.requested_schema, JSON.parse(ASK_USER_QUESTION_SCHEMA));

    const requestId = String(parked.request_id);
    const answered = await runCli(
      [...deferArgs, "--format", "json", "respond", requestId, "--field", "question_0=Greeting A"],
      homeDir,
      { timeoutMs: 30_000 },
    );
    assert.equal(answered.code, 0, `${answered.stdout}${answered.stderr}`);
    const payload = JSON.parse(answered.stdout.trim()) as {
      state: string;
      resolution?: { source?: string; action?: string };
    };
    assert.equal(payload.state, "answered");
    assert.equal(payload.resolution?.source, "cli");
    assert.equal(payload.resolution?.action, "accept");

    // The turn resumes and the agent receives exactly the content that was
    // typed — this is the end of the chain the milestone exists to close.
    await waitFor(async () => {
      const stream = await readSessionStream(homeDir);
      return stream.includes('elicitation accepted:{\\"question_0\\":\\"Greeting A\\"}') ||
        stream.includes('elicitation accepted:{"question_0":"Greeting A"}')
        ? "done"
        : null;
    }, 25_000);

    const events = await readPendingRequestEvents(homeDir);
    assert.deepEqual(
      events.map((entry) => `${entry.event}:${entry.state}`),
      ["created:pending", "answered:answered"],
    );
  });
});

test("integration: --text answers a single-field form and refuses a multi-field one", async () => {
  const singleFieldSchema = JSON.stringify({
    type: "object",
    properties: { answer: { type: "string" } },
  });
  await withParkedElicitation(
    async ({ homeDir, deferArgs }) => {
      const requestId = String((await listRequestsJson(homeDir, deferArgs))[0]?.request_id);
      const answered = await runCli(
        [...deferArgs, "--format", "json", "respond", requestId, "--text", "Greeting B"],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(answered.code, 0, `${answered.stdout}${answered.stderr}`);

      await waitFor(async () => {
        const stream = await readSessionStream(homeDir);
        return stream.includes("Greeting B") ? "done" : null;
      }, 25_000);
    },
    elicitPrompt(singleFieldSchema, "Say something"),
  );

  // The AskUserQuestion shape has two fields for one question — the enum and
  // its free-text companion — so --text has to be told which one.
  await withParkedElicitation(async ({ homeDir, deferArgs }) => {
    const requestId = String((await listRequestsJson(homeDir, deferArgs))[0]?.request_id);
    const refused = await runCli(
      [...deferArgs, "respond", requestId, "--text", "Greeting A"],
      homeDir,
      { timeoutMs: 30_000 },
    );
    assert.equal(refused.code, 2, `${refused.stdout}${refused.stderr}`);
    assert.match(
      `${refused.stdout}${refused.stderr}`,
      /--text answers a one-field form, or a question paired with its free-text field/,
    );
    assert.match(`${refused.stdout}${refused.stderr}`, /fields: question_0, question_0_custom/);
    // Refusing to answer leaves the request answerable.
    assert.equal((await readStoredPendingRequests(homeDir))[0]?.state, "pending");
  });
});

test("integration: --field coerces booleans, numbers and lists by the agent's schema", async () => {
  // Spec-shaped: the SDK validates `elicitation/create` on the agent side, so a
  // schema that is not a real ACP ElicitationSchema never reaches acpx at all.
  const typedSchema = JSON.stringify({
    type: "object",
    properties: {
      ready: { type: "boolean" },
      count: { type: "integer" },
      picks: { type: "array", items: { type: "string", enum: ["a", "b"] } },
    },
  });
  await withParkedElicitation(
    async ({ homeDir, deferArgs }) => {
      const requestId = String((await listRequestsJson(homeDir, deferArgs))[0]?.request_id);
      const answered = await runCli(
        [
          ...deferArgs,
          "--format",
          "json",
          "respond",
          requestId,
          "--field",
          "ready=true",
          "--field",
          "count=3",
          "--field",
          "picks=a,b",
        ],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(answered.code, 0, `${answered.stdout}${answered.stderr}`);

      // The agent echoes what it received, so this asserts the JSON types that
      // crossed the wire, not just the strings that were typed.
      await waitFor(async () => {
        const stream = await readSessionStream(homeDir);
        return stream.includes('ready\\":true') && stream.includes('count\\":3') ? "done" : null;
      }, 25_000);
      const stream = await readSessionStream(homeDir);
      assert.match(stream, /picks\\":\[\\"a\\",\\"b\\"\]/);
    },
    elicitPrompt(typedSchema, "Typed form"),
  );
});

test("integration: an elicitation can be declined and cancelled", async () => {
  await withParkedElicitation(async ({ homeDir, deferArgs }) => {
    const requestId = String((await listRequestsJson(homeDir, deferArgs))[0]?.request_id);
    const declined = await runCli(
      [...deferArgs, "--format", "json", "respond", requestId, "--decline"],
      homeDir,
      { timeoutMs: 30_000 },
    );
    assert.equal(declined.code, 0, `${declined.stdout}${declined.stderr}`);
    const payload = JSON.parse(declined.stdout.trim()) as {
      state: string;
      resolution?: { action?: string };
    };
    // Declining a form is an answer, not a cancellation: the agent is told the
    // user skipped it, and the turn carries on.
    assert.equal(payload.state, "answered");
    assert.equal(payload.resolution?.action, "decline");

    await waitFor(async () => {
      const stream = await readSessionStream(homeDir);
      return stream.includes("elicitation decline") ? "done" : null;
    }, 25_000);
  });

  await withParkedElicitation(async ({ homeDir, deferArgs }) => {
    const requestId = String((await listRequestsJson(homeDir, deferArgs))[0]?.request_id);
    const cancelled = await runCli(
      [...deferArgs, "--format", "json", "respond", requestId, "--cancel"],
      homeDir,
      { timeoutMs: 30_000 },
    );
    assert.equal(cancelled.code, 0, `${cancelled.stdout}${cancelled.stderr}`);
    const payload = JSON.parse(cancelled.stdout.trim()) as {
      state: string;
      resolution?: { action?: string };
    };
    assert.equal(payload.state, "cancelled");
    assert.equal(payload.resolution?.action, "cancel");
  });
});

test("integration: --option is refused for an elicitation, and --field for a permission", async () => {
  await withParkedElicitation(async ({ homeDir, deferArgs }) => {
    const requestId = String((await listRequestsJson(homeDir, deferArgs))[0]?.request_id);
    const refused = await runCli(
      [...deferArgs, "respond", requestId, "--option", "allow"],
      homeDir,
      { timeoutMs: 30_000 },
    );
    assert.equal(refused.code, 2, `${refused.stdout}${refused.stderr}`);
    assert.match(
      `${refused.stdout}${refused.stderr}`,
      /is an elicitation and is answered by filling in its form/,
    );
    assert.equal((await readStoredPendingRequests(homeDir))[0]?.state, "pending");
  });

  await withParkedRequest(async ({ homeDir, deferArgs }) => {
    const requestId = String((await listRequestsJson(homeDir, deferArgs))[0]?.request_id);
    const refused = await runCli(
      [...deferArgs, "respond", requestId, "--field", "question_0=x"],
      homeDir,
      { timeoutMs: 30_000 },
    );
    assert.equal(refused.code, 2, `${refused.stdout}${refused.stderr}`);
    assert.match(`${refused.stdout}${refused.stderr}`, /is a permission request, not a form/);
    assert.equal((await readStoredPendingRequests(homeDir))[0]?.state, "pending");
  });
});

test("integration: an expired elicitation declines and never accepts", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    try {
      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "new"], homeDir);

      const result = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--defer",
          "--defer-max-age",
          "1",
          "--format",
          "json",
          "--ttl",
          "20",
          "prompt",
          elicitPrompt(),
        ],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(result.code, 0, result.stderr);
      // Nobody filled the form in, so the agent is told it was skipped. It is
      // never told a human accepted something a human never typed.
      assert.match(result.stdout, /elicitation decline/);

      const stored = await readStoredPendingRequests(homeDir);
      assert.equal(stored.length, 1, JSON.stringify(stored));
      assert.equal(stored[0]?.kind, "elicitation");
      assert.equal(stored[0]?.state, "expired");
      assert.equal(stored[0]?.resolution?.source, "expiry");
      assert.equal(stored[0]?.resolution?.action, "decline");

      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "close"], homeDir);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: form elicitation is advertised only when the owner can park", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));
    try {
      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "new"], homeDir);

      // Without --defer nothing here can answer a form, so acpx stays silent
      // and the agent keeps its own default behaviour (claude-agent-acp leaves
      // AskUserQuestion in disallowedTools). Advertising with no answerer would
      // re-enable the tool only to auto-decline it.
      const stock = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "quiet",
          "--ttl",
          "20",
          "prompt",
          "client-capabilities",
        ],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(stock.code, 0, stock.stderr);
      assert.match(stock.stdout, /client capabilities:/);
      assert.equal(
        stock.stdout.includes("elicitation"),
        false,
        `capability advertised without a parking owner: ${stock.stdout}`,
      );
      await runCli([...baseAgentArgs(cwd), "--format", "json", "sessions", "close"], homeDir);

      const deferArgs = [...baseAgentArgs(cwd), "--defer", "--defer-max-age", "0"];
      await runCli([...deferArgs, "--format", "json", "sessions", "new"], homeDir);
      const parking = await runCli(
        [...deferArgs, "--format", "quiet", "--ttl", "20", "prompt", "client-capabilities"],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(parking.code, 0, parking.stderr);
      assert.match(parking.stdout, /"elicitation":\{"form":\{\}\}/);
      await runCli([...deferArgs, "--format", "json", "sessions", "close"], homeDir);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

test("integration: --accept answers a form that has nothing to fill in", async () => {
  // A zero-property schema is valid ACP. Without --accept the only answers
  // acpx could give were decline and cancel, so "accepted, with nothing to
  // say" was unreachable.
  const emptySchema = JSON.stringify({ type: "object", properties: {} });
  await withParkedElicitation(
    async ({ homeDir, deferArgs }) => {
      const requestId = String((await listRequestsJson(homeDir, deferArgs))[0]?.request_id);
      const accepted = await runCli(
        [...deferArgs, "--format", "json", "respond", requestId, "--accept"],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(accepted.code, 0, `${accepted.stdout}${accepted.stderr}`);
      const payload = JSON.parse(accepted.stdout.trim()) as {
        state: string;
        resolution?: { action?: string };
      };
      assert.equal(payload.state, "answered");
      assert.equal(payload.resolution?.action, "accept");

      await waitFor(async () => {
        const stream = await readSessionStream(homeDir);
        return stream.includes("elicitation accepted:{}") ? "done" : null;
      }, 25_000);
    },
    elicitPrompt(emptySchema, "Nothing to fill in"),
  );
});

test("integration: a comma-bearing option is refused as a list and reachable when repeated", async () => {
  // The hazard the multi-select sugar carries: an offered value may itself
  // contain a comma, and then no escaping makes a comma-separated list
  // readable. Repeating --field is what reaches it.
  const commaSchema = JSON.stringify({
    type: "object",
    properties: {
      picks: { type: "array", items: { type: "string", enum: ["x,y", "z"] } },
    },
  });
  await withParkedElicitation(
    async ({ homeDir, deferArgs }) => {
      const requestId = String((await listRequestsJson(homeDir, deferArgs))[0]?.request_id);

      const refused = await runCli(
        [...deferArgs, "respond", requestId, "--field", "picks=x,y"],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(refused.code, 2, `${refused.stdout}${refused.stderr}`);
      assert.match(`${refused.stdout}${refused.stderr}`, /cannot be read unambiguously/);
      // Refusing to answer leaves the request answerable.
      assert.equal((await readStoredPendingRequests(homeDir))[0]?.state, "pending");

      const accepted = await runCli(
        [
          ...deferArgs,
          "--format",
          "json",
          "respond",
          requestId,
          "--field",
          "picks=z",
          "--field",
          "picks=x,y",
        ],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(accepted.code, 0, `${accepted.stdout}${accepted.stderr}`);

      // The agent echoes what it received: the two values, one of which contains
      // the comma that could never have survived a split.
      await waitFor(async () => {
        const stream = await readSessionStream(homeDir);
        return stream.includes('picks\\":[\\"z\\",\\"x,y\\"]') ? "done" : null;
      }, 25_000);
    },
    elicitPrompt(commaSchema, "Pick some"),
  );
});

/**
 * One question rendered the way an AskUserQuestion bridge renders it: the
 * offered options, plus the free-text companion marked with the shared
 * `_askUserQuestionCustomAnswer` meta key.
 */
const MARKED_QUESTION_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    q_main: {
      type: "string",
      title: "Greeting",
      oneOf: [
        { const: "Hello from A", title: "Greeting A" },
        { const: "Hello from B", title: "Greeting B" },
      ],
    },
    q_free: {
      type: "string",
      title: "Other",
      _meta: { _askUserQuestionCustomAnswer: { questionId: "q_main", isCustomAnswer: true } },
    },
  },
});

test("integration: --text picks an offered option on a marked question pair", async () => {
  await withParkedElicitation(
    async ({ homeDir, deferArgs }) => {
      const requestId = String((await listRequestsJson(homeDir, deferArgs))[0]?.request_id);
      // Named by its title; the value behind it is what the agent receives.
      const answered = await runCli(
        [...deferArgs, "--format", "json", "respond", requestId, "--text", "Greeting B"],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(answered.code, 0, `${answered.stdout}${answered.stderr}`);

      // Asserted on the exact accepted payload, because the schema echoed in the
      // prompt mentions both field names too.
      await waitFor(async () => {
        const accepted = await readAcceptedElicitationContent(homeDir);
        return accepted === undefined ? null : accepted;
      }, 25_000);
      assert.equal(await readAcceptedElicitationContent(homeDir), '{"q_main":"Hello from B"}');
    },
    elicitPrompt(MARKED_QUESTION_SCHEMA, "Which greeting?"),
  );
});

test("integration: --text writes its own answer into the marked free-text field", async () => {
  await withParkedElicitation(
    async ({ homeDir, deferArgs }) => {
      const requestId = String((await listRequestsJson(homeDir, deferArgs))[0]?.request_id);
      const answered = await runCli(
        [...deferArgs, "--format", "json", "respond", requestId, "--text", "Hello from Zed"],
        homeDir,
        { timeoutMs: 30_000 },
      );
      assert.equal(answered.code, 0, `${answered.stdout}${answered.stderr}`);

      // Not one of the offered options, so it is the operator writing their own
      // answer — which is exactly what the companion field is for.
      await waitFor(async () => {
        const accepted = await readAcceptedElicitationContent(homeDir);
        return accepted === undefined ? null : accepted;
      }, 25_000);
      assert.equal(await readAcceptedElicitationContent(homeDir), '{"q_free":"Hello from Zed"}');
    },
    elicitPrompt(MARKED_QUESTION_SCHEMA, "Which greeting?"),
  );
});
