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

/**
 * ACP models `type: "array"` as a multi-select enum, and its values are strings
 * by definition — `items.enum` is a string list, and `items.anyOf` is a list of
 * titled options whose `const` is a string. These fixtures therefore cover the
 * two spec shapes plus the one hazard they carry: a legal option value may
 * itself contain a comma, or be padded with whitespace.
 */
const COMMA_ENUM = makeEntry({
  picks: { type: "array", items: { type: "string", enum: ["x,y", "z"] } },
});
const PADDED_ENUM = makeEntry({
  picks: { type: "array", items: { type: "string", enum: [" lead", "trail "] } },
});
const SAFE_ENUM = makeEntry({
  picks: { type: "array", items: { type: "string", enum: ["a", "b"] } },
});
const TITLED_ENUM = makeEntry({
  picks: {
    type: "array",
    items: {
      anyOf: [
        { const: "x,y", title: "X or Y" },
        { const: "z", title: "Z" },
      ],
    },
  },
});
const FREE_ARRAY = makeEntry({ picks: { type: "array", items: { type: "string" } } });

test("repeated --field builds a multi-select list, each value taken literally", () => {
  // The authoritative form: one occurrence per chosen value, so a value that
  // contains a comma needs no escaping grammar to reach the agent.
  assert.deepEqual(elicitationContentFromFlags(COMMA_ENUM, { field: ["picks=z", "picks=x,y"] }), {
    picks: ["z", "x,y"],
  });
  assert.deepEqual(
    elicitationContentFromFlags(PADDED_ENUM, { field: ["picks= lead", "picks=trail "] }),
    // Not trimmed: trimming would name a different option than the one typed.
    { picks: [" lead", "trail "] },
  );
  assert.deepEqual(elicitationContentFromFlags(SAFE_ENUM, { field: ["picks=a", "picks=b"] }), {
    picks: ["a", "b"],
  });
});

test("the comma form is refused when an offered value contains a comma", () => {
  // Every escape a caller might reach for arrives here as a plain comma-bearing
  // string, and none of them can be told apart from a two-item list — so the
  // form is refused outright rather than silently answered with the wrong list.
  for (const probe of ["picks=x,y", "picks=x\\,y", 'picks="x,y"', "picks=x, y"]) {
    assert.throws(
      () => elicitationContentFromFlags(COMMA_ENUM, { field: [probe] }),
      /cannot be read unambiguously/,
      probe,
    );
  }
  // Titled options carry their value in `const`, and the same hazard with it.
  assert.throws(
    () => elicitationContentFromFlags(TITLED_ENUM, { field: ["picks=x,y"] }),
    /cannot be read unambiguously/,
  );
  // Percent-encoding is not decoded anywhere, so it is simply not that value.
  assert.throws(
    () => elicitationContentFromFlags(COMMA_ENUM, { field: ["picks=x%2Cy"] }),
    /does not offer "x%2Cy"/,
  );
});

test("a single value is still reachable when the comma form is refused", () => {
  // Nothing to split, so this is unambiguous and stays allowed.
  assert.deepEqual(elicitationContentFromFlags(COMMA_ENUM, { field: ["picks=z"] }), {
    picks: ["z"],
  });
  // And it is not trimmed, so a padded option is reachable by name.
  assert.deepEqual(elicitationContentFromFlags(PADDED_ENUM, { field: ["picks= lead"] }), {
    picks: [" lead"],
  });
  assert.deepEqual(elicitationContentFromFlags(COMMA_ENUM, { field: ["picks="] }), { picks: [] });
});

test("a split that cannot match the schema is refused, never delivered", () => {
  assert.deepEqual(elicitationContentFromFlags(SAFE_ENUM, { field: ["picks=a, b"] }), {
    picks: ["a", "b"],
  });
  assert.throws(
    () => elicitationContentFromFlags(SAFE_ENUM, { field: ["picks=a,c"] }),
    /does not offer "c" \(values: "a", "b"\)/,
  );
  assert.throws(
    () => elicitationContentFromFlags(SAFE_ENUM, { field: ["picks=c", "picks=d"] }),
    /does not offer "c", "d"/,
  );
});

test("an array with no offered values keeps the comma-split sugar", () => {
  // Nothing to be ambiguous against and nothing to validate against, so the
  // convenient reading is the only reading available.
  assert.deepEqual(elicitationContentFromFlags(FREE_ARRAY, { field: ["picks=a, b"] }), {
    picks: ["a", "b"],
  });
  assert.deepEqual(elicitationContentFromFlags(FREE_ARRAY, { field: ["picks=a,b", "picks=c"] }), {
    picks: ["a,b", "c"],
  });
});

test("--text answers a single multi-select field through the same rules", () => {
  const single = makeEntry({ picks: { type: "array", items: { type: "string", enum: ["x,y"] } } });
  assert.throws(
    () => elicitationContentFromFlags(single, { text: "x,y" }),
    /cannot be read unambiguously/,
  );
});

test("only a multi-select field takes more than one value", () => {
  assert.throws(
    () => elicitationContentFromFlags(TYPED_FIELDS, { field: ["who=a", "who=b"] }),
    /--field who was given more than once/,
  );
});

test("non-string array items are left as the strings they were typed as", () => {
  // Not a shape ACP's multi-select can have — its values are strings by
  // definition — so this only pins what a custom schema gets today: the items
  // are delivered as typed, not converted one by one.
  const numeric = makeEntry({ picks: { type: "array", items: { type: "number" } } });
  assert.deepEqual(elicitationContentFromFlags(numeric, { field: ["picks=1,2"] }), {
    picks: ["1", "2"],
  });
});

test("a number is read by JSON's grammar, not JavaScript's", () => {
  assert.deepEqual(elicitationContentFromFlags(TYPED_FIELDS, { field: ["count=1e3"] }), {
    count: 1000,
  });
  assert.deepEqual(elicitationContentFromFlags(TYPED_FIELDS, { field: ["ratio=-2.5"] }), {
    ratio: -2.5,
  });
  assert.deepEqual(elicitationContentFromFlags(TYPED_FIELDS, { field: ["ratio= 3 "] }), {
    ratio: 3,
  });

  // `Number()` reads all of these as numbers nobody typed — 0x1F as 31, 0b11 as
  // 3, 0o17 as 15 — and the field would then carry a value the operator never
  // wrote. The refusal echoes exactly what was typed.
  for (const [probe, echoed] of [
    ["count=0x1F", '"0x1F"'],
    ["count=0b11", '"0b11"'],
    ["count=0o17", '"0o17"'],
    ["count=007", '"007"'],
    ["count=+5", '"+5"'],
    ["ratio=Infinity", '"Infinity"'],
    ["ratio=1_0", '"1_0"'],
  ] as const) {
    assert.throws(
      () => elicitationContentFromFlags(TYPED_FIELDS, { field: [probe] }),
      new RegExp(`is (a number|an integer); ${echoed.replaceAll(/[+"]/g, "\\$&")} is not one`),
      probe,
    );
  }
});

test("--accept answers a form that has nothing to fill in", () => {
  // A zero-property schema is valid ACP, and until now acpx could only decline
  // it: there was no way to say "accepted, with nothing to say".
  const empty = makeEntry({});
  assert.deepEqual(elicitationContentFromFlags(empty, { accept: true }), {});
  // It also carries whatever fields were named alongside it.
  assert.deepEqual(elicitationContentFromFlags(TYPED_FIELDS, { accept: true, field: ["who=a"] }), {
    who: "a",
  });
});

test("--accept still cannot skip a required field", () => {
  const required = makeEntry({ who: { type: "string" } }, { required: ["who"] });
  assert.throws(() => elicitationContentFromFlags(required, { accept: true }), /requires who/);
  assert.deepEqual(elicitationContentFromFlags(required, { accept: true, field: ["who=a"] }), {
    who: "a",
  });
});
