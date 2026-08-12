import type { ElicitationProperty } from "./types";

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
const SUPPORTED_TYPES = new Set(["string", "number", "integer", "boolean", "array"]);

const formValueText = (value: FormDataEntryValue): string => {
  if (typeof value !== "string") {
    throw new Error("File answers are not supported by ACP elicitation forms.");
  }
  return value;
};

const isFormValueArray = (
  value: FormDataEntryValue | readonly FormDataEntryValue[],
): value is readonly FormDataEntryValue[] => Array.isArray(value);

const offeredValues = (property: ElicitationProperty): readonly string[] =>
  property.enum ??
  property.oneOf?.map((choice) => choice.const) ??
  property.anyOf?.map((choice) => choice.const) ??
  [];

export const validateElicitationValue = (
  property: ElicitationProperty,
  value: string | number | boolean | readonly string[],
): void => {
  if (Array.isArray(value)) {
    const choices = property.items ? offeredValues(property.items) : [];
    if (choices.length === 0) {
      throw new Error("This multi-select has no supported ACP choices.");
    }
    if (value.some((item) => !choices.includes(item))) {
      throw new Error("The answer contains a value the agent did not offer.");
    }
    if (property.minItems !== undefined && value.length < property.minItems) {
      throw new Error(`Select at least ${property.minItems} option(s).`);
    }
    if (property.maxItems !== undefined && value.length > property.maxItems) {
      throw new Error(`Select at most ${property.maxItems} option(s).`);
    }
    return;
  }
  if (typeof value === "string") {
    const choices = offeredValues(property);
    if (choices.length > 0 && !choices.includes(value)) {
      throw new Error("The answer is not one of the values the agent offered.");
    }
    if (property.minLength !== undefined && value.length < property.minLength) {
      throw new Error(`Enter at least ${property.minLength} character(s).`);
    }
    if (property.maxLength !== undefined && value.length > property.maxLength) {
      throw new Error(`Enter at most ${property.maxLength} character(s).`);
    }
    if (property.pattern !== undefined) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(property.pattern, "u");
      } catch {
        throw new Error("The agent supplied an invalid validation pattern.");
      }
      if (!pattern.test(value)) {
        throw new Error("The answer does not match the requested format.");
      }
    }
    if (property.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
      throw new Error("Enter a valid email address.");
    }
    if (property.format === "uri") {
      try {
        const parsed = new URL(value);
        void parsed;
      } catch {
        throw new Error("Enter a valid absolute URL.");
      }
    }
    if (property.format === "date" && !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
      throw new Error("Enter a valid date.");
    }
    if (
      property.format === "date-time" &&
      (!/^\d{4}-\d{2}-\d{2}T/u.test(value) || Number.isNaN(Date.parse(value)))
    ) {
      throw new Error("Enter a valid date and time.");
    }
    return;
  }
  if (typeof value === "number") {
    if (property.minimum !== undefined && value < property.minimum) {
      throw new Error(`Enter a value of at least ${property.minimum}.`);
    }
    if (property.maximum !== undefined && value > property.maximum) {
      throw new Error(`Enter a value of at most ${property.maximum}.`);
    }
  }
};

export const coerceElicitationValue = (
  property: ElicitationProperty,
  value: FormDataEntryValue | readonly FormDataEntryValue[],
): unknown => {
  if (property.type !== undefined && !SUPPORTED_TYPES.has(property.type)) {
    throw new Error(`Unsupported ACP elicitation field type “${property.type}”.`);
  }
  if (isFormValueArray(value)) {
    const items = value.map(formValueText);
    validateElicitationValue(property, items);
    return items;
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
    validateElicitationValue(property, number);
    return number;
  }
  if (property.type === "boolean") {
    if (scalar !== "true" && scalar !== "false") {
      throw new Error(`“${scalar}” is not a valid boolean.`);
    }
    return scalar === "true";
  }
  validateElicitationValue(property, scalar);
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
