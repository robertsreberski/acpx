import assert from "node:assert/strict";
import test from "node:test";
import { coerceElicitationValue } from "../src/elicitation";

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
  assert.deepEqual(coerceElicitationValue({ type: "array" }, ["x,y", " z "]), ["x,y", " z "]);
});
