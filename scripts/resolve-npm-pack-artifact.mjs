#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parsePackResult(output) {
  const trimmed = output.trim();
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== "[") {
      continue;
    }
    try {
      const value = JSON.parse(trimmed.slice(index));
      if (Array.isArray(value)) {
        return value;
      }
    } catch {
      // Lifecycle output may precede npm's final JSON document.
    }
  }
  throw new Error("npm pack did not emit a parseable JSON result");
}

export function resolveNpmPackArtifact(packageDirectory, packOutput) {
  const result = parsePackResult(packOutput);
  if (result.length !== 1) {
    throw new Error(`npm pack reported ${result.length} artifacts; expected exactly one`);
  }

  const filename = result[0]?.filename;
  if (
    typeof filename !== "string" ||
    filename.length === 0 ||
    filename !== path.basename(filename) ||
    !filename.endsWith(".tgz")
  ) {
    throw new Error("npm pack reported an invalid artifact filename");
  }

  const packageRoot = path.resolve(packageDirectory);
  const artifact = path.resolve(packageRoot, filename);
  const stat = fs.lstatSync(artifact);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`npm pack artifact is not a regular file: ${artifact}`);
  }
  return artifact;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [packageDirectory, outputFile, ...extra] = process.argv.slice(2);
  if (!packageDirectory || !outputFile || extra.length > 0) {
    console.error(
      "Usage: node scripts/resolve-npm-pack-artifact.mjs <package-directory> <pack-output-file>",
    );
    process.exitCode = 2;
  } else {
    const output = fs.readFileSync(outputFile, "utf8");
    console.log(resolveNpmPackArtifact(packageDirectory, output));
  }
}
