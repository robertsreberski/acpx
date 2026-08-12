import assert from "node:assert/strict";
import test from "node:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { PermissionPromptUnavailableError } from "../src/errors.js";
import {
  classifyPermissionDecision,
  decisionToResponse,
  inferToolKind,
  matchPermissionPolicy,
  resolvePermissionRequest,
  resolvePermissionRequestWithDetails,
} from "../src/permissions.js";
import { withMockedReadline, withTtyState } from "./tty-test-helpers.js";

const BASE_OPTIONS = [
  { optionId: "allow", kind: "allow_once" },
  { optionId: "reject", kind: "reject_once" },
] as const;

type PermissionChoice = {
  optionId: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
};

function makeRequest(kind: RequestPermissionRequest["toolCall"]["kind"]): RequestPermissionRequest {
  return {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "tool-1",
      kind,
      title: "tool call",
    },
    options: BASE_OPTIONS.map((option) => Object.assign({}, option)),
  } as RequestPermissionRequest;
}

function makeRequestWithTitle(
  title: string | undefined,
  kind?: RequestPermissionRequest["toolCall"]["kind"],
  options: PermissionChoice[] = BASE_OPTIONS.map((option) => Object.assign({}, option)),
  rawInput?: unknown,
): RequestPermissionRequest {
  return {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "tool-1",
      kind,
      title,
      ...(rawInput !== undefined ? { rawInput } : {}),
    },
    options: options.map((option) => Object.assign({}, option)),
  } as RequestPermissionRequest;
}

function withNonTty<T>(run: () => Promise<T>): Promise<T> {
  return withTtyState({ stdin: false, stderr: false }, run);
}

test("approve-all approves everything", async () => {
  const request = makeRequest("execute");
  const response = await resolvePermissionRequest(request, "approve-all");
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "allow" } });
});

test("deny-all denies everything", async () => {
  const request = makeRequest("execute");
  const response = await resolvePermissionRequest(request, "deny-all");
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "reject" } });
});

test("approve-reads approves reads and denies writes", async () => {
  await withNonTty(async () => {
    const readResponse = await resolvePermissionRequest(makeRequest("read"), "approve-reads");
    assert.deepEqual(readResponse, {
      outcome: { outcome: "selected", optionId: "allow" },
    });

    const writeResponse = await resolvePermissionRequest(makeRequest("edit"), "approve-reads");
    assert.deepEqual(writeResponse, {
      outcome: { outcome: "selected", optionId: "reject" },
    });
  });
});

test("non-interactive policy fail throws when prompt is required", async () => {
  await withNonTty(async () => {
    await assert.rejects(
      async () => await resolvePermissionRequest(makeRequest("edit"), "approve-reads", "fail"),
      PermissionPromptUnavailableError,
    );
  });
});

test("approve-all falls back to the first option when no allow option exists", async () => {
  const response = await resolvePermissionRequest(
    makeRequestWithTitle("tool", "execute", [{ optionId: "custom", kind: "reject_once" }]),
    "approve-all",
  );

  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "custom" } });
});

test("deny-all cancels when no reject option exists", async () => {
  const response = await resolvePermissionRequest(
    makeRequestWithTitle("tool", "execute", [{ optionId: "allow", kind: "allow_once" }]),
    "deny-all",
  );

  assert.deepEqual(response, { outcome: { outcome: "cancelled" } });
});

test("approve-reads infers read-like titles without an explicit tool kind", async () => {
  await withNonTty(async () => {
    for (const title of ["cat: README.md", "grep: TODO", "search: prompts"]) {
      const response = await resolvePermissionRequest(
        makeRequestWithTitle(title, undefined),
        "approve-reads",
      );

      assert.deepEqual(response, {
        outcome: { outcome: "selected", optionId: "allow" },
      });
    }
  });
});

test("approve-reads rejects non-read title inference when prompting is unavailable", async () => {
  await withNonTty(async () => {
    for (const title of [
      "patch: src/cli.ts",
      "remove: old-file",
      "rename: before after",
      "run: pnpm test",
      "http: https://example.com",
      "think: plan",
      undefined,
    ]) {
      const response = await resolvePermissionRequest(
        makeRequestWithTitle(title, undefined),
        "approve-reads",
      );

      assert.deepEqual(response, {
        outcome: { outcome: "selected", optionId: "reject" },
      });
    }
  });
});

test("approve-reads prompts interactively for non-read tools", async () => {
  let closed = false;
  await withTtyState({ stdin: true, stderr: true }, async () => {
    await withMockedReadline(
      () => ({
        question: async () => "yes",
        close: () => {
          closed = true;
        },
      }),
      async () => {
        const response = await resolvePermissionRequest(
          makeRequestWithTitle("run: pnpm test", undefined),
          "approve-reads",
        );

        assert.deepEqual(response, {
          outcome: { outcome: "selected", optionId: "allow" },
        });
      },
    );
  });

  assert.equal(closed, true);
});

test("permission policy auto-approves and auto-denies matched tools", async () => {
  await withNonTty(async () => {
    const executeResponse = await resolvePermissionRequest(
      makeRequestWithTitle("Bash: pnpm test", "execute"),
      "deny-all",
      "deny",
      { autoApprove: ["bash"] },
    );
    assert.deepEqual(executeResponse, {
      outcome: { outcome: "selected", optionId: "allow" },
    });

    const readResponse = await resolvePermissionRequest(
      makeRequestWithTitle("Read", "read"),
      "approve-all",
      "deny",
      { autoDeny: ["read"] },
    );
    assert.deepEqual(readResponse, {
      outcome: { outcome: "selected", optionId: "reject" },
    });
  });
});

test("permission policy escalation emits a structured event in non-TTY", async () => {
  await withNonTty(async () => {
    const result = await resolvePermissionRequestWithDetails(
      makeRequestWithTitle("Bash: pnpm test", "execute", undefined, {
        command: "pnpm",
        args: ["test"],
      }),
      "approve-reads",
      "deny",
      { escalate: ["execute"] },
    );

    assert.equal(result.escalation?.type, "permission_escalation");
    assert.equal(result.escalation?.sessionId, "session-1");
    assert.equal(result.escalation?.toolName, "Bash");
    assert.equal(result.escalation?.toolTitle, "Bash: pnpm test");
    assert.deepEqual(result.escalation?.toolInput, { command: "pnpm", args: ["test"] });
    assert.equal(result.escalation?.toolKind, "execute");
    assert.equal(result.escalation?.matchedRule, "execute");
    assert.equal(result.escalation?.action, "escalate");
    assert.equal(result.escalation?.message, "Permission escalation required for Bash: pnpm test");
    assert.deepEqual(result.response, {
      outcome: { outcome: "selected", optionId: "reject" },
      _meta: {
        acpx: {
          permissionEscalation: result.escalation,
        },
      },
    });
  });
});

test("permission policy defer degrades to the escalation path in non-TTY", async () => {
  await withNonTty(async () => {
    const result = await resolvePermissionRequestWithDetails(
      makeRequestWithTitle("Bash: pnpm test", "execute", undefined, {
        command: "pnpm",
        args: ["test"],
      }),
      "approve-reads",
      "deny",
      { defer: ["execute"] },
    );

    assert.equal(result.escalation?.type, "permission_escalation");
    assert.equal(result.escalation?.action, "defer");
    assert.equal(result.escalation?.sessionId, "session-1");
    assert.equal(result.escalation?.toolName, "Bash");
    assert.equal(result.escalation?.toolTitle, "Bash: pnpm test");
    assert.deepEqual(result.escalation?.toolInput, { command: "pnpm", args: ["test"] });
    assert.equal(result.escalation?.toolKind, "execute");
    assert.equal(result.escalation?.matchedRule, "execute");
    assert.equal(result.escalation?.message, "Permission deferral required for Bash: pnpm test");
    assert.deepEqual(result.response, {
      outcome: { outcome: "selected", optionId: "reject" },
      _meta: {
        acpx: {
          permissionEscalation: result.escalation,
        },
      },
    });
  });
});

test("permission policy defer cancels when the request offers no reject option", async () => {
  await withNonTty(async () => {
    const result = await resolvePermissionRequestWithDetails(
      makeRequestWithTitle("Bash: pnpm test", "execute", [
        { optionId: "allow", kind: "allow_once" },
      ]),
      "approve-all",
      "deny",
      { defer: ["execute"] },
    );

    assert.equal(result.escalation?.action, "defer");
    assert.deepEqual(result.response, {
      outcome: { outcome: "cancelled" },
      _meta: {
        acpx: {
          permissionEscalation: result.escalation,
        },
      },
    });
  });
});

test("permission policy defer prompts interactively just like escalate", async () => {
  await withTtyState({ stdin: true, stderr: true }, async () => {
    await withMockedReadline(
      () => ({
        question: async () => "yes",
        close: () => {},
      }),
      async () => {
        const result = await resolvePermissionRequestWithDetails(
          makeRequestWithTitle("Bash: pnpm test", "execute"),
          "deny-all",
          "deny",
          { defer: ["execute"] },
        );

        assert.equal(result.escalation, undefined);
        assert.deepEqual(result.response, {
          outcome: { outcome: "selected", optionId: "allow" },
        });
      },
    );
  });
});

test("permission policy defaultAction defer degrades to a defer escalation", async () => {
  await withNonTty(async () => {
    const result = await resolvePermissionRequestWithDetails(
      makeRequestWithTitle("Write", "edit"),
      "approve-all",
      "deny",
      { autoApprove: ["read"], defaultAction: "defer" },
    );

    assert.equal(result.escalation?.action, "defer");
    assert.equal(result.escalation?.matchedRule, undefined);
    assert.deepEqual(result.response, {
      outcome: { outcome: "selected", optionId: "reject" },
      _meta: {
        acpx: {
          permissionEscalation: result.escalation,
        },
      },
    });
  });
});

test("matchPermissionPolicy ranks autoDeny, autoApprove, escalate, defer, then defaultAction", () => {
  const request = makeRequestWithTitle("Bash: pnpm test", "execute");

  assert.deepEqual(
    matchPermissionPolicy(request, {
      autoDeny: ["execute"],
      autoApprove: ["execute"],
      escalate: ["execute"],
      defer: ["execute"],
      defaultAction: "approve",
    }),
    { action: "deny", matchedRule: "execute" },
  );
  assert.deepEqual(
    matchPermissionPolicy(request, {
      autoApprove: ["execute"],
      escalate: ["execute"],
      defer: ["execute"],
      defaultAction: "approve",
    }),
    { action: "approve", matchedRule: "execute" },
  );
  assert.deepEqual(
    matchPermissionPolicy(request, {
      escalate: ["execute"],
      defer: ["execute"],
      defaultAction: "approve",
    }),
    { action: "escalate", matchedRule: "execute" },
  );
  assert.deepEqual(
    matchPermissionPolicy(request, { defer: ["execute"], defaultAction: "approve" }),
    { action: "defer", matchedRule: "execute" },
  );
  assert.deepEqual(matchPermissionPolicy(request, { defer: ["read"], defaultAction: "defer" }), {
    action: "defer",
  });
});

test("matchPermissionPolicy is unaffected by an absent defer list", () => {
  const request = makeRequestWithTitle("Bash: pnpm test", "execute");

  assert.equal(matchPermissionPolicy(request, undefined), undefined);
  assert.equal(matchPermissionPolicy(request, {}), undefined);
  assert.equal(matchPermissionPolicy(request, { escalate: ["read"] }), undefined);
  assert.deepEqual(matchPermissionPolicy(request, { escalate: ["execute"] }), {
    action: "escalate",
    matchedRule: "execute",
  });
  assert.deepEqual(matchPermissionPolicy(request, { defaultAction: "deny" }), { action: "deny" });
});

test("permission policy matches raw tool names but not raw command arguments", async () => {
  await withNonTty(async () => {
    const byToolName = await resolvePermissionRequest(
      makeRequestWithTitle("Run task", "execute", undefined, {
        toolName: "Bash",
        command: "pnpm test",
      }),
      "deny-all",
      "deny",
      { autoApprove: ["bash"] },
    );
    assert.deepEqual(byToolName, {
      outcome: { outcome: "selected", optionId: "allow" },
    });

    const byCommand = await resolvePermissionRequest(
      makeRequestWithTitle("Run task", "execute", undefined, {
        command: "pnpm test",
      }),
      "deny-all",
      "deny",
      { autoApprove: ["pnpm test"] },
    );
    assert.deepEqual(byCommand, {
      outcome: { outcome: "selected", optionId: "reject" },
    });
  });
});

test("permission policy defaultAction falls back only when no rule matches", async () => {
  await withNonTty(async () => {
    const response = await resolvePermissionRequest(
      makeRequestWithTitle("Write", "edit"),
      "approve-all",
      "deny",
      { autoApprove: ["read"], defaultAction: "deny" },
    );
    assert.deepEqual(response, {
      outcome: { outcome: "selected", optionId: "reject" },
    });
  });
});

test("classifyPermissionDecision maps selected outcomes to approved, denied, or cancelled", () => {
  const request = makeRequest("execute");

  assert.equal(
    classifyPermissionDecision(request, {
      outcome: { outcome: "selected", optionId: "allow" },
    }),
    "approved",
  );
  assert.equal(
    classifyPermissionDecision(request, {
      outcome: { outcome: "selected", optionId: "reject" },
    }),
    "denied",
  );
  assert.equal(
    classifyPermissionDecision(request, {
      outcome: { outcome: "selected", optionId: "missing" },
    }),
    "cancelled",
  );
  assert.equal(
    classifyPermissionDecision(request, {
      outcome: { outcome: "cancelled" },
    }),
    "cancelled",
  );
});

test("decisionToResponse allow_once prefers allow_once over allow_always", () => {
  const request = makeRequestWithTitle("tool", "edit", [
    { optionId: "always", kind: "allow_always" },
    { optionId: "once", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ]);
  const response = decisionToResponse(request, { outcome: "allow_once" });
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "once" } });
});

test("decisionToResponse allow_always prefers allow_always over allow_once", () => {
  const request = makeRequestWithTitle("tool", "edit", [
    { optionId: "once", kind: "allow_once" },
    { optionId: "always", kind: "allow_always" },
    { optionId: "reject", kind: "reject_once" },
  ]);
  const response = decisionToResponse(request, { outcome: "allow_always" });
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "always" } });
});

test("decisionToResponse allow_once falls back to allow_always when allow_once is missing", () => {
  const request = makeRequestWithTitle("tool", "edit", [
    { optionId: "always", kind: "allow_always" },
    { optionId: "reject", kind: "reject_once" },
  ]);
  const response = decisionToResponse(request, { outcome: "allow_once" });
  assert.deepEqual(response, { outcome: { outcome: "selected", optionId: "always" } });
});

test("decisionToResponse reject_once falls back to reject_always", () => {
  const onlyAlways = makeRequestWithTitle("tool", "edit", [
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject-always", kind: "reject_always" },
  ]);
  assert.deepEqual(decisionToResponse(onlyAlways, { outcome: "reject_once" }), {
    outcome: { outcome: "selected", optionId: "reject-always" },
  });
});

test("decisionToResponse cancels when no matching option exists", () => {
  const request = makeRequestWithTitle("tool", "edit", [{ optionId: "allow", kind: "allow_once" }]);
  assert.deepEqual(decisionToResponse(request, { outcome: "reject_once" }), {
    outcome: { outcome: "cancelled" },
  });
});

test("decisionToResponse cancel always returns cancelled", () => {
  const request = makeRequestWithTitle("tool", "edit", [
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ]);
  assert.deepEqual(decisionToResponse(request, { outcome: "cancel" }), {
    outcome: { outcome: "cancelled" },
  });
});

test("decisionToResponse select picks the exact option id", () => {
  const request = makeRequestWithTitle("tool", "edit", [
    { optionId: "allow", kind: "allow_once" },
    { optionId: "allow-forever", kind: "allow_always" },
    { optionId: "reject", kind: "reject_once" },
  ]);
  assert.deepEqual(decisionToResponse(request, { outcome: "select", optionId: "allow-forever" }), {
    outcome: { outcome: "selected", optionId: "allow-forever" },
  });
});

test("decisionToResponse select honours agent-specific option ids", () => {
  const request = makeRequestWithTitle("tool", "edit", [
    { optionId: "allow", kind: "allow_once" },
    { optionId: "acme-allow-with-audit", kind: "allow_always" },
  ]);
  assert.deepEqual(
    decisionToResponse(request, { outcome: "select", optionId: "acme-allow-with-audit" }),
    { outcome: { outcome: "selected", optionId: "acme-allow-with-audit" } },
  );
});

test("decisionToResponse select cancels instead of falling back by option kind", () => {
  const request = makeRequestWithTitle("tool", "edit", [
    { optionId: "allow", kind: "allow_once" },
    { optionId: "allow-forever", kind: "allow_always" },
    { optionId: "reject", kind: "reject_once" },
  ]);
  assert.deepEqual(decisionToResponse(request, { outcome: "select", optionId: "not-offered" }), {
    outcome: { outcome: "cancelled" },
  });
});

test("decisionToResponse select cancels when the request offers no options", () => {
  const request = makeRequestWithTitle("tool", "edit", []);
  assert.deepEqual(decisionToResponse(request, { outcome: "select", optionId: "allow" }), {
    outcome: { outcome: "cancelled" },
  });
});

test("classifyPermissionDecision classifies arbitrary selected options by their kind", () => {
  const request = makeRequestWithTitle("tool", "edit", [
    { optionId: "acme-allow-with-audit", kind: "allow_always" },
    { optionId: "acme-reject-and-explain", kind: "reject_always" },
  ]);

  assert.equal(
    classifyPermissionDecision(request, {
      outcome: { outcome: "selected", optionId: "acme-allow-with-audit" },
    }),
    "approved",
  );
  assert.equal(
    classifyPermissionDecision(request, {
      outcome: { outcome: "selected", optionId: "acme-reject-and-explain" },
    }),
    "denied",
  );
});

test("inferToolKind classifies titles when toolCall.kind is missing", () => {
  assert.equal(inferToolKind(makeRequest("edit")), "edit");
  assert.equal(inferToolKind(makeRequestWithTitle("patch: foo.ts", undefined)), "edit");
  assert.equal(inferToolKind(makeRequestWithTitle("cat README", undefined)), "read");
  assert.equal(inferToolKind(makeRequestWithTitle("totally unknown", undefined)), "other");
});
