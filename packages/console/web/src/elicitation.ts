import type { ElicitationProperty } from "./types";

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

const formValueText = (value: FormDataEntryValue): string => {
  if (typeof value !== "string") {
    throw new Error("File answers are not supported by ACP elicitation forms.");
  }
  return value;
};

const isFormValueArray = (
  value: FormDataEntryValue | readonly FormDataEntryValue[],
): value is readonly FormDataEntryValue[] => Array.isArray(value);

export const coerceElicitationValue = (
  property: ElicitationProperty,
  value: FormDataEntryValue | readonly FormDataEntryValue[],
): unknown => {
  if (isFormValueArray(value)) {
    return value.map(formValueText);
  }
  const scalar = formValueText(value);
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

export interface BooleanElicitationChoice {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export const booleanElicitationChoices = (
  required: boolean,
): readonly BooleanElicitationChoice[] => [
  { value: "", label: required ? "Select…" : "No answer", disabled: required },
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];

export type ElicitationFieldRead =
  | { readonly kind: "missing" }
  | { readonly kind: "omitted" }
  | { readonly kind: "value"; readonly value: unknown };

export const readElicitationField = (
  property: ElicitationProperty,
  values: readonly FormDataEntryValue[],
  required: boolean,
): ElicitationFieldRead => {
  if (values.length === 0 || (values.length === 1 && formValueText(values[0]) === "")) {
    return { kind: required ? "missing" : "omitted" };
  }
  return {
    kind: "value",
    value: coerceElicitationValue(property, property.type === "array" ? values : values[0]),
  };
};
