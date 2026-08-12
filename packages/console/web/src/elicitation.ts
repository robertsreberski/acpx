import type { ElicitationProperty } from "./types";

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

export const coerceElicitationValue = (
  property: ElicitationProperty,
  value: FormDataEntryValue | readonly FormDataEntryValue[],
): unknown => {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  const scalar = String(value);
  if (property.type === "number" || property.type === "integer") {
    const normalized = scalar.trim();
    if (!JSON_NUMBER.test(normalized)) {
      throw new Error(`“${scalar}” is not a valid JSON number.`);
    }
    const number = Number(normalized);
    if (!Number.isFinite(number) || (property.type === "integer" && !Number.isInteger(number))) {
      throw new Error(`“${scalar}” is not a valid ${property.type}.`);
    }
    return number;
  }
  if (property.type === "boolean") {
    return scalar === "true";
  }
  return scalar;
};
