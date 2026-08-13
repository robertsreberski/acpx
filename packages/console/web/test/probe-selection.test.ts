import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogHasValue,
  catalogOptions,
  preselectedMode,
  preselectedModel,
  probeHint,
} from "../src/probe-selection";
import type { ProbeCatalog } from "../src/types";

const codexModes: ProbeCatalog = {
  advertised: true,
  // Codex advertises its write-capable mode as the current one.
  currentValue: "agent",
  options: [
    { value: "read-only", label: "Read only" },
    { value: "agent", label: "Agent" },
    { value: "agent-full-access", label: "Agent (full access)" },
  ],
};

test("the agent's advertised default never upgrades a session to write access", () => {
  // Codex says "agent"; the console pins Codex to read-only. Inheriting the
  // advertised default would silently make a new session write-capable.
  assert.equal(preselectedMode(codexModes, "read-only"), "read-only");
  assert.notEqual(
    preselectedMode(codexModes, "read-only"),
    codexModes.advertised && codexModes.currentValue,
  );
});

test("no mode is preselected when the safe default is not on offer", () => {
  assert.equal(preselectedMode(codexModes, "default"), "");
  assert.equal(preselectedMode(codexModes, undefined), "");
  assert.equal(preselectedMode({ advertised: false }, "read-only"), "");
  assert.equal(preselectedMode(undefined, "read-only"), "");
});

test("the advertised current model is a safe starting point", () => {
  assert.equal(
    preselectedModel({
      advertised: true,
      currentValue: "gpt-5.6-sol",
      options: [
        { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { value: "gpt-5.2", label: "GPT-5.2" },
      ],
    }),
    "gpt-5.6-sol",
  );
});

test("a current model the agent did not actually offer is not preselected", () => {
  assert.equal(
    preselectedModel({
      advertised: true,
      currentValue: "retired-model",
      options: [{ value: "gpt-5.2", label: "GPT-5.2" }],
    }),
    "",
  );
  assert.equal(preselectedModel({ advertised: false }), "");
});

test("an unadvertised catalog offers nothing rather than an empty dropdown", () => {
  assert.deepEqual(catalogOptions({ advertised: false }), []);
  assert.deepEqual(catalogOptions(undefined), []);
  assert.equal(catalogHasValue({ advertised: false }, "anything"), false);
  assert.equal(catalogHasValue(codexModes, "agent"), true);
});

test("every outcome that yields no list still tells the operator what to do", () => {
  assert.match(probeHint(undefined, true) ?? "", /Asking the agent/u);
  assert.match(probeHint({ status: "unsupported" }, false) ?? "", /exact ID/u);
  assert.match(
    probeHint({ status: "failed", code: "auth_required" }, false) ?? "",
    /signed in.*exact ID/u,
  );
  assert.match(probeHint({ status: "failed", code: "timeout" }, false) ?? "", /did not answer/u);
  assert.equal(probeHint({ status: "ready" }, false), undefined);
});
