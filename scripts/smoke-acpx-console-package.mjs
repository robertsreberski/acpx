#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNpmPackArtifact } from "./resolve-npm-pack-artifact.mjs";

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

async function getResponse(url, host) {
  return await new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Host: host } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.once("end", () =>
        resolve({ status: response.statusCode, headers: response.headers, body }),
      );
    });
    request.setTimeout(2_000, () => request.destroy(new Error(`Timed out reading ${url}`)));
    request.once("error", reject);
  });
}

async function getJson(url, host) {
  const response = await getResponse(url, host);
  try {
    return { ...response, body: JSON.parse(response.body) };
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${response.body}`, { cause: error });
  }
}

async function packageTarball(packDir, packageDir, before) {
  const packed = await run("npm", ["pack", "--silent", "--json", "--pack-destination", packDir], {
    cwd: packageDir,
  });
  const artifact = resolveNpmPackArtifact(packDir, packed.stdout);
  const after = await fs.readdir(packDir);
  const created = after.filter((name) => name.endsWith(".tgz") && !before.has(name));
  assert.equal(
    created.length,
    1,
    `Expected one tarball from ${packageDir}; got ${created.join(", ")}`,
  );
  assert.equal(artifact, path.join(packDir, created[0]));
  return artifact;
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const registryAcpx = args.includes("--registry-acpx");
  const unknownArgs = args.filter((arg) => arg !== "--registry-acpx");
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown argument: ${unknownArgs.join(", ")}`);
  }
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
    const consoleManifest = JSON.parse(
      await fs.readFile(path.join(consolePackageDir, "package.json"), "utf8"),
    );
    const expectedAcpxVersion = consoleManifest.dependencies?.acpx;
    assert.match(
      expectedAcpxVersion,
      /^\d+\.\d+\.\d+(?:-fork\.\d+)?$/,
      "acpx-console must declare an exact releasable acpx dependency",
    );
    await Promise.all([
      fs.mkdir(packDir, { recursive: true }),
      fs.mkdir(installDir, { recursive: true }),
      fs.mkdir(homeDir, { recursive: true }),
      fs.mkdir(workspace, { recursive: true }),
    ]);

    if (!registryAcpx) {
      await run("pnpm", ["run", "build"], { inherit: true });
    }
    await run("pnpm", ["run", "build"], { cwd: consolePackageDir, inherit: true });

    const acpxTarball = registryAcpx
      ? undefined
      : await packageTarball(packDir, root, new Set(await fs.readdir(packDir)));
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
    assert.equal(packedConsoleManifest.dependencies.acpx, expectedAcpxVersion);
    assert.doesNotMatch(JSON.stringify(packedConsoleManifest), /workspace:/);
    const packedNotice = await run("tar", ["-xOf", consoleTarball, "package/NOTICE"], {
      cwd: scratch,
    });
    assert.equal(
      packedNotice.stdout,
      await fs.readFile(path.join(consolePackageDir, "NOTICE"), "utf8"),
      "The packed console must distribute the verified third-party notices",
    );
    const installSpecs = acpxTarball ? [acpxTarball, consoleTarball] : [consoleTarball];
    await run("npm", ["install", "--ignore-scripts", "--prefix", installDir, ...installSpecs], {
      inherit: true,
    });
    await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import assert from "node:assert/strict";
          import { readFile } from "node:fs/promises";
          const manifest = JSON.parse(await readFile("node_modules/acpx/package.json", "utf8"));
          assert.equal(manifest.name, "acpx");
          assert.equal(manifest.version, ${JSON.stringify(expectedAcpxVersion)});
          const sessions = await import("acpx/sessions");
          assert.equal(typeof sessions.createAcpxSessionService, "function");
        `,
      ],
      { cwd: installDir },
    );

    consoleBin = path.join(installDir, "node_modules", ".bin", "acpx-console");
    const version = await run(consoleBin, ["--version"], { env });
    assert.equal(version.stdout.trim(), consoleManifest.version);
    const help = await run(consoleBin, ["--help"], { env });
    assert.match(help.stdout, /start --detach/);
    assert.match(help.stdout, /--trust-network/);

    const port = await availablePort();
    let start;
    try {
      start = await run(
        consoleBin,
        [
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

    const status = await run(consoleBin, ["status", "--json", "--state-dir", stateDir], { env });
    const statusValue = JSON.parse(status.stdout);
    assert.equal(statusValue.status, "running");
    assert.equal(statusValue.record.port, port);
    startedPid = statusValue.record.pid;

    const health = await getJson(`http://127.0.0.1:${port}/healthz`, "127.0.0.1");
    assert.equal(health.status, 200, JSON.stringify(health.body));
    assert.equal(health.body.status, "ok");
    const bootstrap = await getJson(`http://127.0.0.1:${port}/api/v1/bootstrap`, "127.0.0.1");
    if (bootstrap.status !== 200) {
      const diagnostics = await fs
        .readFile(path.join(stateDir, "console.error.log"), "utf8")
        .catch(() => "<console error log unavailable>");
      throw new Error(`Bootstrap failed: ${JSON.stringify(bootstrap.body)}\n${diagnostics}`);
    }
    assert.equal(bootstrap.body.version, 1);
    assert(Array.isArray(bootstrap.body.agents));
    assert(Array.isArray(bootstrap.body.sessions));
    const staticPage = await getResponse(`http://127.0.0.1:${port}/`, "127.0.0.1");
    assert.equal(staticPage.status, 200);
    assert.match(String(staticPage.headers["content-type"]), /^text\/html\b/);
    assert.match(staticPage.body, /<title>ACPX Console<\/title>/);
    const assetPath = staticPage.body.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
    assert(assetPath, "The installed console page must reference its production JavaScript");
    const staticAsset = await getResponse(
      new URL(assetPath, `http://127.0.0.1:${port}/`).href,
      "127.0.0.1",
    );
    assert.equal(staticAsset.status, 200);
    assert.match(String(staticAsset.headers["content-type"]), /javascript/);
    assert(staticAsset.body.length > 1_000, "The installed console JavaScript asset is empty");

    const stop = await run(consoleBin, ["stop", "--state-dir", stateDir], {
      env,
    });
    assert.match(stop.stdout, /Stopped ACPX Console/);
    startedPid = undefined;
    const stopped = await run(consoleBin, ["status", "--json", "--state-dir", stateDir], {
      env,
      allowFailure: true,
    });
    assert.equal(stopped.code, 1);
    assert.equal(JSON.parse(stopped.stdout).status, "stopped");

    console.log("ACPX Console packed-artifact smoke passed");
  } finally {
    if (consoleBin) {
      await run(consoleBin, ["stop", "--state-dir", stateDir], {
        env,
        allowFailure: true,
      }).catch(() => undefined);
    }
    if (startedPid && Number.isInteger(startedPid)) {
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
