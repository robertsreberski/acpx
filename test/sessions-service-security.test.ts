import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadResolvedConfig } from "../src/cli/config.js";
import { sessionsServiceTestInternals } from "../src/sessions-service/service.js";
import { AcpxAgentNotRegisteredError, createAcpxSessionService } from "../src/sessions.js";
import { withTempHome } from "./runtime-test-helpers.js";

test("browser-supplied agent ids cannot launch unregistered commands", async () => {
  await withTempHome("acpx-sessions-security-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const marker = path.join(homeDir, "must-not-run");
    const injected = `${process.execPath} -e require('node:fs').writeFileSync(${JSON.stringify(marker)},'x')`;
    await fs.mkdir(cwd, { recursive: true });
    const service = createAcpxSessionService({ cwd });

    for (const invoke of [
      async () => await service.listProviderSessions({ agentId: injected, cwd }),
      async () =>
        await service.createSession({
          agentId: injected,
          cwd,
          idempotencyKey: "unregistered-create",
        }),
      async () =>
        await service.adoptSession({
          agentId: injected,
          cwd,
          providerSessionId: "provider-session",
          idempotencyKey: "unregistered-adopt",
        }),
    ]) {
      await assert.rejects(invoke, AcpxAgentNotRegisteredError);
    }

    await assert.rejects(async () => await fs.access(marker));
    service.dispose();
  });
});

test("a configured built-in command override without argv never falls back to stock argv", async () => {
  await withTempHome("acpx-sessions-security-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { codex: { command: "custom-codex-acp --safe" } } })}\n`,
      "utf8",
    );
    const config = await loadResolvedConfig(cwd);

    assert.equal(sessionsServiceTestInternals.configuredAgentArgv("codex", config), undefined);
  });
});

test("adapter operations have a bounded default with explicit config and service overrides", async () => {
  await withTempHome("acpx-sessions-security-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const config = await loadResolvedConfig(cwd);
    assert.equal(sessionsServiceTestInternals.adapterOperationTimeout({}, config), 60_000);
    assert.equal(
      sessionsServiceTestInternals.adapterOperationTimeout(
        { adapterOperationTimeoutMs: 125 },
        config,
      ),
      125,
    );

    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ timeout: 3 })}\n`,
      "utf8",
    );
    const configured = await loadResolvedConfig(cwd);
    assert.equal(sessionsServiceTestInternals.adapterOperationTimeout({}, configured), 3_000);
  });
});
