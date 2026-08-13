#!/usr/bin/env node
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const noticePath = join(repoRoot, "packages", "console", "NOTICE");
const viteConfigPath = join(repoRoot, "packages", "console", "web", "vite.config.ts");

const mitUseComposedRef = `MIT License

Copyright (C) Andarist and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// use-composed-ref@1.4.0 declares MIT in package.json but omits the license file
// from its npm tarball. Keep this version-specific so upgrades require a fresh
// attribution audit instead of silently inheriting the exception.
const missingLicenseText = new Map([["use-composed-ref@1.4.0", mitUseComposedRef]]);

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readLicenseRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Vite emitted an invalid bundled-license record");
  }
  const { name, version, identifier } = value;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    typeof version !== "string" ||
    version.length === 0 ||
    typeof identifier !== "string" ||
    identifier.length === 0
  ) {
    throw new Error("Vite emitted an incomplete bundled-license record");
  }
  const packageId = `${name}@${version}`;
  const emittedText = typeof value.text === "string" ? value.text.trim() : "";
  const text = emittedText || missingLicenseText.get(packageId);
  if (!text) {
    throw new Error(`${packageId} (${identifier}) is bundled without distributable license text`);
  }
  return { name, version, identifier, packageId, text };
}

async function collectBundledLicenses() {
  const outputDir = await mkdtemp(join(tmpdir(), "acpx-console-notices-"));
  const inventoryFile = "bundled-licenses.json";
  try {
    await build({
      configFile: viteConfigPath,
      logLevel: "silent",
      build: {
        emptyOutDir: true,
        license: { fileName: inventoryFile },
        outDir: outputDir,
        sourcemap: false,
      },
    });
    const raw = JSON.parse(await readFile(join(outputDir, inventoryFile), "utf8"));
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error("Vite did not report any bundled production dependencies");
    }
    const records = raw
      .map(readLicenseRecord)
      .toSorted((left, right) => compareStrings(left.packageId, right.packageId));
    const packageIds = new Set(records.map((record) => record.packageId));
    for (const packageId of missingLicenseText.keys()) {
      if (!packageIds.has(packageId)) {
        throw new Error(`Remove stale bundled-license fallback for ${packageId}`);
      }
    }
    return records;
  } finally {
    await rm(outputDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function renderNotice(records) {
  const licenseGroups = new Map();
  for (const record of records) {
    const groupKey = `${record.identifier}\0${record.text}`;
    const group = licenseGroups.get(groupKey);
    if (group) {
      group.packages.push(record.packageId);
    } else {
      licenseGroups.set(groupKey, {
        identifier: record.identifier,
        packages: [record.packageId],
        text: record.text,
      });
    }
  }

  const lines = [
    "ACPX Console Third-Party Notices",
    "================================",
    "",
    "This file is generated from Vite's production browser bundle by",
    "scripts/console-third-party-notices.mjs. Do not edit it manually.",
    "",
    "Bundled package inventory",
    "--------------------------",
    "",
    ...records.map((record) => `- ${record.packageId} (${record.identifier})`),
    "",
    "License texts",
    "-------------",
    "",
  ];

  const groups = [...licenseGroups.values()].toSorted((left, right) =>
    compareStrings(left.packages[0], right.packages[0]),
  );
  for (const [index, group] of groups.entries()) {
    lines.push(`License ${index + 1}: ${group.identifier}`, "", "Applies to:");
    lines.push(...group.packages.map((packageId) => `- ${packageId}`), "", group.text, "");
  }

  lines.push(
    "Project provenance note",
    "-----------------------",
    "",
    "The ACPX Console implementation in this package was written independently.",
    "It does not copy source code from the GPL-licensed mono-agent web console.",
    "",
  );
  return lines.join("\n");
}

async function main() {
  const mode = process.argv[2] ?? "--check";
  if (mode !== "--check" && mode !== "--write") {
    throw new Error("Usage: console-third-party-notices.mjs [--check|--write]");
  }
  const records = await collectBundledLicenses();
  const expected = renderNotice(records);
  if (mode === "--write") {
    await writeFile(noticePath, expected, "utf8");
    console.log(`Wrote ${records.length} bundled package attributions to packages/console/NOTICE`);
    return;
  }
  const actual = await readFile(noticePath, "utf8");
  if (actual !== expected) {
    throw new Error(
      "packages/console/NOTICE does not match the production web bundle; run pnpm --filter acpx-console notice:generate",
    );
  }
  console.log(`Verified ${records.length} bundled package attributions in packages/console/NOTICE`);
}

await main();
