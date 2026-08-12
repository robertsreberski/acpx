#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const consolePackageDir = path.join(root, "packages", "console");

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
        reject(new Error(`${command} ${args.join(" ")} failed (${code ?? signal})\n${stderr}`));
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

async function getJson(url, host) {
  return await new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Host: host } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.once("end", () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(new Error(`Invalid JSON from ${url}: ${body}`, { cause: error }));
        }
      });
    });
    request.setTimeout(2_000, () => request.destroy(new Error(`Timed out reading ${url}`)));
    request.once("error", reject);
  });
}

async function packageTarball(packDir, packageDir, before) {
  await run("npm", ["pack", "--pack-destination", packDir], { cwd: packageDir, inherit: true });
  const after = await fs.readdir(packDir);
  const created = after.filter((name) => name.endsWith(".tgz") && !before.has(name));
  assert.equal(
    created.length,
    1,
    `Expected one tarball from ${packageDir}; got ${created.join(", ")}`,
  );
  return path.join(packDir, created[0]);
}

async function main() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-console-package-smoke-"));
  const packDir = path.join(scratch, "packs");
  const installDir = path.join(scratch, "install");
  const homeDir = path.join(scratch, "home");
  const workspace = path.join(scratch, "workspace");
  const stateDir = path.join(homeDir, ".acpx", "console");
  let startedPid;
  let consoleBin;
  const env = { ...process.env, HOME: homeDir };
  delete env.NODE_V8_COVERAGE;

  try {
    await Promise.all([
      fs.mkdir(packDir, { recursive: true }),
      fs.mkdir(installDir, { recursive: true }),
      fs.mkdir(homeDir, { recursive: true }),
      fs.mkdir(workspace, { recursive: true }),
    ]);

    await run("pnpm", ["run", "build"], { inherit: true });
    await run("pnpm", ["run", "build"], { cwd: consolePackageDir, inherit: true });

    const acpxTarball = await packageTarball(packDir, root, new Set(await fs.readdir(packDir)));
    const consoleTarball = await packageTarball(
      packDir,
      consolePackageDir,
      new Set(await fs.readdir(packDir)),
    );
    const packedConsoleManifest = JSON.parse(
      (
        await run("tar", ["-xOf", consoleTarball, "package/package.json"], {
          cwd: scratch,
        })
      ).stdout,
    );
    assert.equal(packedConsoleManifest.dependencies.acpx, "0.13.0-fork.2");
    assert.doesNotMatch(JSON.stringify(packedConsoleManifest), /workspace:/);
    await run(
      "npm",
      ["install", "--ignore-scripts", "--prefix", installDir, acpxTarball, consoleTarball],
      { inherit: true },
    );

    consoleBin = path.join(installDir, "node_modules", "acpx-console", "dist", "cli.js");
    const version = await run(process.execPath, [consoleBin, "--version"], { env });
    assert.match(version.stdout.trim(), /^0\.1\.0(?:[-+].*)?$/);
    const help = await run(process.execPath, [consoleBin, "--help"], { env });
    assert.match(help.stdout, /start --detach/);
    assert.match(help.stdout, /--trust-network/);

    const port = await availablePort();
    let start;
    try {
      start = await run(
        process.execPath,
        [
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
        ],
        { env },
      );
    } catch (error) {
      const diagnostics = await fs
        .readFile(path.join(stateDir, "console.error.log"), "utf8")
        .catch(() => "<console error log unavailable>");
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`, {
        cause: error,
      });
    }
    assert.match(start.stdout, /ACPX Console started/);

    const status = await run(
      process.execPath,
      [consoleBin, "status", "--json", "--state-dir", stateDir],
      {
        env,
      },
    );
    const statusValue = JSON.parse(status.stdout);
    assert.equal(statusValue.status, "running");
    assert.equal(statusValue.record.port, port);
    startedPid = statusValue.record.pid;

    const health = await getJson(`http://127.0.0.1:${port}/healthz`, "127.0.0.1");
    assert.equal(health.status, 200);
    assert.equal(health.body.status, "ok");
    const bootstrap = await getJson(`http://127.0.0.1:${port}/api/v1/bootstrap`, "127.0.0.1");
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.body.version, 1);
    assert(Array.isArray(bootstrap.body.agents));
    assert(Array.isArray(bootstrap.body.sessions));

    const stop = await run(process.execPath, [consoleBin, "stop", "--state-dir", stateDir], {
      env,
    });
    assert.match(stop.stdout, /Stopped ACPX Console/);
    startedPid = undefined;
    const stopped = await run(
      process.execPath,
      [consoleBin, "status", "--json", "--state-dir", stateDir],
      { env, allowFailure: true },
    );
    assert.equal(stopped.code, 1);
    assert.equal(JSON.parse(stopped.stdout).status, "stopped");

    console.log("ACPX Console packed-artifact smoke passed");
  } finally {
    if (startedPid && Number.isInteger(startedPid)) {
      if (consoleBin) {
        await run(process.execPath, [consoleBin, "stop", "--state-dir", stateDir], {
          env,
          allowFailure: true,
        }).catch(() => undefined);
      }
      try {
        process.kill(startedPid, "SIGTERM");
      } catch {
        // The detached process already exited.
      }
    }
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

await main();
