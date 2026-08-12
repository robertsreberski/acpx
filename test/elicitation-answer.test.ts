import assert from "node:assert/strict";
import test from "node:test";
import { elicitationContentFromFlags } from "../src/cli/elicitation-answer.js";
import {
  PENDING_REQUEST_SCHEMA,
  type PendingElicitationRequest,
} from "../src/session/pending-requests.js";

function makeEntry(
  properties: Record<string, unknown>,
  extras: Record<string, unknown> = {},
): PendingElicitationRequest {
  return {
    schema: PENDING_REQUEST_SCHEMA,
    requestId: "req-1",
    sessionId: "session-1",
    acpSessionId: "acp-1",
    agentCommand: "node ./test/mock-agent.js",
    cwd: "/workspace",
    kind: "elicitation",
    state: "pending",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    ownerPid: 1,
    ownerGeneration: 1,
    taskRequestId: "task-1",
    elicitation: {
      message: "Fill this in",
      mode: "form",
      requestedSchema: { type: "object", properties, ...extras },
    },
  };
}

const TYPED_FIELDS = makeEntry({
  who: { type: "string" },
  ready: { type: "boolean" },
  ratio: { type: "number" },
  count: { type: "integer" },
  picks: { type: "array", items: { enum: ["a", "b", "c"] } },
  untyped: {},
});

test("each schema type decides how its command-line value is read", () => {
  assert.deepEqual(
    elicitationContentFromFlags(TYPED_FIELDS, {
      field: [
        "who=Greeting A",
        "ready=true",
        "ratio=1.5",
        "count=42",
        "picks=a, b ,c",
        "untyped=whatever",
      ],
    }),
    {
      who: "Greeting A",
      ready: true,
      ratio: 1.5,
      count: 42,
      // Comma-separated, with the whitespace around each item trimmed.
      picks: ["a", "b", "c"],
      // No declared type means nothing to convert to.
      untyped: "whatever",
    },
  );

  // The values are really typed, not stringly typed that happen to compare
  // equal: an agent reading `true` must not get "true".
  const typed = elicitationContentFromFlags(TYPED_FIELDS, {
    field: ["ready=false", "count=0", "ratio=-2"],
  });
  assert.equal(typeof typed.ready, "boolean");
  assert.equal(typed.ready, false);
  assert.equal(typeof typed.count, "number");
  assert.equal(typed.count, 0);
  assert.equal(typed.ratio, -2);
});

test("an empty list selects nothing rather than one blank item", () => {
  assert.deepEqual(elicitationContentFromFlags(TYPED_FIELDS, { field: ["picks="] }), {
    picks: [],
  });
});

test("a value that is not what the schema asked for is refused, never coerced anyway", () => {
  for (const [field, message] of [
    ["ready=yes", /boolean; pass true or false/],
    ["ready=TRUE", /boolean; pass true or false/],
    ["ratio=abc", /is a number/],
    // An empty numeric field would otherwise read as 0, which is an answer
    // nobody typed.
    ["ratio=", /is a number/],
    ["count=1.5", /is an integer/],
  ] as const) {
    assert.throws(
      () => elicitationContentFromFlags(TYPED_FIELDS, { field: [field] }),
      message,
      field,
    );
  }
});

test("a field the form does not have is refused with the ones it does", () => {
  assert.throws(
    () => elicitationContentFromFlags(TYPED_FIELDS, { field: ["nope=1"] }),
    /has no field "nope" \(fields: who, ready, ratio, count, picks, untyped\)/,
  );
});

test("a field assignment has to name a field", () => {
  assert.throws(
    () => elicitationContentFromFlags(TYPED_FIELDS, { field: ["who"] }),
    /--field expects <key>=<value>/,
  );
  assert.throws(
    () => elicitationContentFromFlags(TYPED_FIELDS, { field: ["=value"] }),
    /--field expects <key>=<value>/,
  );
});

test("a value may contain '=' because only the first one splits", () => {
  assert.deepEqual(elicitationContentFromFlags(TYPED_FIELDS, { field: ["who=a=b=c"] }), {
    who: "a=b=c",
  });
});

test("the same field twice is refused rather than silently last-one-wins", () => {
  assert.throws(
    () => elicitationContentFromFlags(TYPED_FIELDS, { field: ["who=a", "who=b"] }),
    /--field who was given more than once/,
  );
});

test("a schema type acpx cannot build is refused, not sent as a bare string", () => {
  const exotic = makeEntry({ shape: { type: "object" } });
  assert.throws(
    () => elicitationContentFromFlags(exotic, { field: ['shape={"a":1}'] }),
    /schema type "object", which acpx cannot fill in/,
  );
});

test("--text fills in a single-field form and refuses to guess for more", () => {
  const single = makeEntry({ answer: { type: "string" } });
  assert.deepEqual(elicitationContentFromFlags(single, { text: "just this" }), {
    answer: "just this",
  });

  // AskUserQuestion pairs every question with its own free-text field, so even
  // a one-question form has two properties and --text cannot pick between them.
  assert.throws(
    () => elicitationContentFromFlags(TYPED_FIELDS, { text: "which one?" }),
    /--text answers a form with exactly one field, but request req-1 has 6/,
  );
  assert.throws(
    () => elicitationContentFromFlags(makeEntry({}), { text: "nothing to fill" }),
    /has 0 \(fields: none\)/,
  );
});

test("--text is typed by the schema exactly like --field", () => {
  const single = makeEntry({ ready: { type: "boolean" } });
  assert.deepEqual(elicitationContentFromFlags(single, { text: "true" }), { ready: true });
  assert.throws(() => elicitationContentFromFlags(single, { text: "yes" }), /is a boolean/);
});

test("a required field left out is refused before the answer is sent", () => {
  const required = makeEntry(
    { who: { type: "string" }, why: { type: "string" }, extra: { type: "string" } },
    { required: ["who", "why"] },
  );
  assert.throws(
    () => elicitationContentFromFlags(required, { field: ["extra=x"] }),
    /requires who, why/,
  );
  assert.throws(() => elicitationContentFromFlags(required, { field: ["who=a"] }), /requires why/);
  assert.deepEqual(elicitationContentFromFlags(required, { field: ["who=a", "why=b"] }), {
    who: "a",
    why: "b",
  });
});

test("a form with no fields answered by no flags accepts empty content", () => {
  // Every AskUserQuestion field is optional, so accepting without filling any
  // in is a real answer: it means "skip", and the agent handles it as such.
  assert.deepEqual(elicitationContentFromFlags(TYPED_FIELDS, { field: [] }), {});
  assert.deepEqual(elicitationContentFromFlags(TYPED_FIELDS, {}), {});
});
