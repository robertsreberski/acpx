import assert from "node:assert/strict";
import test from "node:test";
import { parseConsoleCommand } from "../src/cli-options.js";

test("start parses repeatable trust-boundary options", () => {
  assert.deepEqual(
    parseConsoleCommand([
      "start",
      "--detach",
      "--host",
      "0.0.0.0",
      "--port",
      "9999",
      "--trust-network",
      "--workspace-root",
      "/one",
      "--workspace-root",
      "/two",
      "--allowed-host",
      "console.test",
    ]),
    {
      command: "start",
      detach: true,
      internalChild: false,
      open: false,
      host: "0.0.0.0",
      port: 9999,
      trustNetwork: true,
      workspaceRoots: ["/one", "/two"],
      allowedHosts: ["console.test"],
    },
  );
});

test("unknown options and malformed values fail closed", () => {
  assert.throws(() => parseConsoleCommand(["start", "--port", "nope"]), /Invalid port/);
  assert.throws(() => parseConsoleCommand(["start", "--mystery"]), /Unknown start option/);
  assert.throws(() => parseConsoleCommand(["stop", "--json"]), /Unknown stop option/);
});
