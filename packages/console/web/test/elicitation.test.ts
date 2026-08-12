import assert from "node:assert/strict";
import test from "node:test";
import {
  booleanElicitationChoices,
  coerceElicitationValue,
  readElicitationField,
} from "../src/elicitation";

test("numeric form values accept JSON numbers and reject JavaScript-only spellings", () => {
  assert.equal(coerceElicitationValue({ type: "number" }, "1e3"), 1_000);
  assert.equal(coerceElicitationValue({ type: "integer" }, " 3 "), 3);
  for (const value of ["0x1F", "0o17", "0b11", "1_0", "+5", "Infinity", "NaN"]) {
    assert.throws(
      () => coerceElicitationValue({ type: "number" }, value),
      /not a valid JSON number/u,
    );
  }
  assert.throws(() => coerceElicitationValue({ type: "integer" }, "2.5"), /not a valid integer/u);
});

test("boolean and multi-select fields preserve explicit false and literal selections", () => {
  assert.equal(coerceElicitationValue({ type: "boolean" }, "false"), false);
  assert.equal(coerceElicitationValue({ type: "boolean" }, "true"), true);
  assert.deepEqual(
    coerceElicitationValue(
      { type: "array", items: { anyOf: [{ const: "x,y" }, { const: " z " }] } },
      ["x,y", " z "],
    ),
    ["x,y", " z "],
  );
});

test("multi-select anyOf and scalar constraints fail closed", () => {
  const multiselect = {
    type: "array",
    minItems: 1,
    maxItems: 2,
    items: { anyOf: [{ const: "one" }, { const: "two" }] },
  } as const;
  assert.deepEqual(coerceElicitationValue(multiselect, ["one", "two"]), ["one", "two"]);
  assert.throws(() => coerceElicitationValue(multiselect, ["future"]), /did not offer/u);
  assert.throws(() => coerceElicitationValue(multiselect, []), /at least 1/u);
  assert.throws(
    () => coerceElicitationValue({ type: "object" }, "{}"),
    /Unsupported ACP elicitation field type/u,
  );
  assert.throws(
    () => coerceElicitationValue({ type: "string", minLength: 3 }, "no"),
    /at least 3/u,
  );
  assert.throws(() => coerceElicitationValue({ type: "number", maximum: 2 }, "3"), /at most 2/u);
  assert.throws(
    () => coerceElicitationValue({ type: "string", format: "email" }, "not-an-email"),
    /valid email/u,
  );
});

test("nullable ACP constraints are treated as absent", () => {
  assert.equal(coerceElicitationValue({ type: "number", minimum: null, maximum: null }, "12"), 12);
  assert.equal(
    coerceElicitationValue(
      { type: "string", minLength: null, maxLength: null, pattern: null, format: null },
      "value",
    ),
    "value",
  );
  assert.deepEqual(
    coerceElicitationValue(
      {
        type: "array",
        minItems: null,
        maxItems: null,
        items: { anyOf: [{ const: "one" }] },
      },
      ["one"],
    ),
    ["one"],
  );
});

test("optional blank scalar fields are omitted instead of fabricating values", () => {
  assert.deepEqual(booleanElicitationChoices(false), [
    { value: "", label: "No answer", disabled: false },
    { value: "true", label: "Yes" },
    { value: "false", label: "No" },
  ]);
  assert.deepEqual(readElicitationField({ type: "boolean" }, [""], false), {
    kind: "omitted",
  });
  assert.deepEqual(readElicitationField({ type: "boolean" }, ["false"], false), {
    kind: "value",
    value: false,
  });
  assert.deepEqual(readElicitationField({ type: "number" }, [""], false), {
    kind: "omitted",
  });
  assert.deepEqual(readElicitationField({ type: "string" }, [""], false), {
    kind: "omitted",
  });
  assert.deepEqual(readElicitationField({ type: "boolean" }, [""], true), {
    kind: "missing",
  });
  assert.deepEqual(readElicitationField({ type: "number" }, [""], true), {
    kind: "missing",
  });
});
