import { InvalidArgumentError } from "commander";
import {
  elicitationFieldNames,
  elicitationSchemaProperties,
  type PendingElicitationRequest,
  type PendingRequestContentValue,
} from "../session/pending-requests.js";

/**
 * Building the content of an `accept` answer from command-line flags.
 *
 * Every value arrives as a string, and the agent's schema is the only thing
 * that says what it should have been. Coercion is therefore driven entirely by
 * `requested_schema`, and a value that cannot be coerced is refused rather than
 * guessed at: an ill-typed field would reach the agent as a real answer.
 */

/** Field types acpx can fill in from a command-line string. */
const COERCIBLE_FIELD_TYPES = ["string", "number", "integer", "boolean", "array"] as const;

function fieldNameList(entry: PendingElicitationRequest): string {
  return elicitationFieldNames(entry).join(", ") || "none";
}

/** The declared type of one field, or undefined when the schema omits it. */
function fieldType(entry: PendingElicitationRequest, field: string): string | undefined {
  const property = elicitationSchemaProperties(entry)[field];
  if (!property || typeof property !== "object" || Array.isArray(property)) {
    return undefined;
  }
  const type = (property as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function requiredFieldNames(entry: PendingElicitationRequest): string[] {
  const required = entry.elicitation.requestedSchema.required;
  return Array.isArray(required) ? required.filter((name) => typeof name === "string") : [];
}

/**
 * JSON's own number grammar.
 *
 * `Number()` is far more permissive than the wire this value is going onto: it
 * reads `0x1F` as 31, `0b11` as 3, `0o17` as 15, `1_0` as 10 and `""` as 0. A
 * field would then carry a number the operator never typed, in a notation it
 * can never be written back as, so only what JSON itself calls a number is
 * accepted.
 */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function coerceNumber(field: string, value: string, integer: boolean): number {
  const trimmed = value.trim();
  const parsed = JSON_NUMBER.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    throw new InvalidArgumentError(
      `Field ${field} is ${integer ? "an integer" : "a number"}; ` +
        `${JSON.stringify(value)} is not one`,
    );
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The values a multi-select field offers.
 *
 * ACP models a `type: "array"` property as a multi-select enum whose values are
 * strings by definition: `items.enum` lists them directly, and `items.anyOf`
 * lists titled options whose `const` is the value. Undefined means the schema
 * named none — a custom or free-form shape — so there is nothing to validate
 * against and nothing to detect an ambiguity from.
 */
function multiSelectCandidates(
  entry: PendingElicitationRequest,
  field: string,
): string[] | undefined {
  const items = asRecord(asRecord(elicitationSchemaProperties(entry)[field])?.items);
  if (!items) {
    return undefined;
  }
  const listed = Array.isArray(items.enum)
    ? items.enum
    : Array.isArray(items.anyOf)
      ? items.anyOf.map((option) => asRecord(option)?.const)
      : [];
  const values = listed.filter((value): value is string => typeof value === "string");
  return values.length > 0 ? values : undefined;
}

/**
 * Whether comma-separating this field's values could mean two things.
 *
 * A comma inside an offered value makes a comma-separated list unreadable, and
 * so does padding whitespace, because splitting trims each item. Neither can be
 * escaped: a backslash, quotes and percent-encoding all arrive here as ordinary
 * characters that are not part of any value the agent offered.
 */
function candidatesAreAmbiguous(candidates: string[]): boolean {
  return candidates.some((value) => value.includes(",") || value.trim() !== value);
}

function assertOfferedValues(
  entry: PendingElicitationRequest,
  field: string,
  items: string[],
  candidates: string[],
): void {
  const unknown = items.filter((item) => !candidates.includes(item));
  if (unknown.length === 0) {
    return;
  }
  throw new InvalidArgumentError(
    `Field ${field} does not offer ${unknown.map((value) => JSON.stringify(value)).join(", ")} ` +
      `(values: ${candidates.map((value) => JSON.stringify(value)).join(", ")}); ` +
      `pass each chosen value as its own --field ${field}=<value>`,
  );
}

/**
 * A comma-separated list. Whitespace around each item is trimmed and an empty
 * value is an empty list, so `--field picks=` selects nothing rather than
 * selecting one blank option.
 */
function splitCommaSeparated(value: string): string[] {
  const trimmed = value.trim();
  return trimmed === "" ? [] : trimmed.split(",").map((item) => item.trim());
}

/**
 * Read the occurrences of one multi-select field.
 *
 * Repeating `--field` is the authoritative form: each occurrence is exactly one
 * value, taken literally, so every legal value is reachable without an escaping
 * grammar acpx would have to invent. A single occurrence keeps the
 * comma-separated sugar, but only where that reading cannot be wrong — when an
 * offered value itself contains a comma the sugar is refused rather than
 * silently answered with a two-item list the schema does not offer.
 */
function coerceMultiSelect(
  entry: PendingElicitationRequest,
  field: string,
  values: string[],
): string[] {
  const candidates = multiSelectCandidates(entry, field);
  const validate = (items: string[]): string[] => {
    if (candidates) {
      assertOfferedValues(entry, field, items, candidates);
    }
    return items;
  };

  if (values.length > 1) {
    return validate(values);
  }
  const only = values[0] ?? "";
  if (candidates && candidatesAreAmbiguous(candidates)) {
    if (only.includes(",")) {
      throw new InvalidArgumentError(
        `Field ${field} offers a value that itself contains a comma or padded whitespace, so a ` +
          `comma-separated list cannot be read unambiguously; pass each chosen value as its own ` +
          `--field ${field}=<value>`,
      );
    }
    // Nothing to split, so this is one value exactly as typed. It is not
    // trimmed either: trimming could name a different option than the one given.
    return validate(only === "" ? [] : [only]);
  }
  return validate(splitCommaSeparated(only));
}

function coerceBoolean(field: string, value: string): boolean {
  if (value === "true" || value === "false") {
    return value === "true";
  }
  throw new InvalidArgumentError(
    `Field ${field} is a boolean; pass true or false, not ${JSON.stringify(value)}`,
  );
}

/**
 * Refused rather than sent as a bare string: the agent asked for a shape acpx
 * cannot build, and inventing one would answer with something the operator
 * never typed. The form can still be declined or cancelled.
 */
function rejectUncoercibleType(field: string, type: string): never {
  throw new InvalidArgumentError(
    `Field ${field} has schema type ${JSON.stringify(type)}, which acpx cannot fill in ` +
      `from the command line (it handles ${COERCIBLE_FIELD_TYPES.join(", ")}); ` +
      `read the schema with 'requests --json', or answer with --decline or --cancel`,
  );
}

function coerceScalarField(
  entry: PendingElicitationRequest,
  field: string,
  value: string,
): PendingRequestContentValue {
  const type = fieldType(entry, field);
  switch (type) {
    // An untyped property is a free-text one as far as a command line is
    // concerned: there is nothing to convert it to.
    case undefined:
    case "string":
      return value;
    case "boolean":
      return coerceBoolean(field, value);
    case "number":
      return coerceNumber(field, value, false);
    case "integer":
      return coerceNumber(field, value, true);
    default:
      return rejectUncoercibleType(field, type);
  }
}

/** Read every occurrence of one field into the value the schema asks for. */
function coerceField(
  entry: PendingElicitationRequest,
  field: string,
  values: string[],
): PendingRequestContentValue {
  if (fieldType(entry, field) === "array") {
    return coerceMultiSelect(entry, field, values);
  }
  if (values.length > 1) {
    // Last-one-wins would silently discard one of two answers the operator
    // deliberately typed, and there is no way to tell which they meant.
    throw new InvalidArgumentError(
      `--field ${field} was given more than once, and only a multi-select (array) field ` +
        `takes more than one value`,
    );
  }
  return coerceScalarField(entry, field, values[0] ?? "");
}

function parseFieldAssignment(raw: string): { field: string; value: string } {
  const separator = raw.indexOf("=");
  if (separator <= 0) {
    throw new InvalidArgumentError(
      `--field expects <key>=<value>; ${JSON.stringify(raw)} has no field name before an '='`,
    );
  }
  // Split on the FIRST '=' only, so a value may contain as many as it likes.
  return { field: raw.slice(0, separator), value: raw.slice(separator + 1) };
}

function assertKnownField(entry: PendingElicitationRequest, field: string): void {
  if (elicitationFieldNames(entry).includes(field)) {
    return;
  }
  throw new InvalidArgumentError(
    `Request ${entry.requestId} has no field ${JSON.stringify(field)} ` +
      `(fields: ${fieldNameList(entry)})`,
  );
}

/**
 * The single field `--text` answers.
 *
 * Sugar for the one-question case only. Guessing which of several fields a bare
 * string belongs to would be answering a question the operator did not answer,
 * so more than one field is refused with the names they would have to choose
 * between.
 */
function soleFieldName(entry: PendingElicitationRequest): string {
  const fields = elicitationFieldNames(entry);
  const [only] = fields;
  if (fields.length !== 1 || only === undefined) {
    throw new InvalidArgumentError(
      `--text answers a form with exactly one field, but request ${entry.requestId} has ` +
        `${fields.length} (fields: ${fieldNameList(entry)}); name one with --field <key>=<value>`,
    );
  }
  return only;
}

function assertRequiredFieldsPresent(
  entry: PendingElicitationRequest,
  content: Record<string, PendingRequestContentValue>,
): void {
  const missing = requiredFieldNames(entry).filter((field) => !(field in content));
  if (missing.length > 0) {
    throw new InvalidArgumentError(
      `Request ${entry.requestId} requires ${missing.join(", ")}; ` +
        `answer with --field <key>=<value> for each, or --decline the form`,
    );
  }
}

/** Occurrences of each named field, in the order they were given. */
function groupFieldAssignments(fields: string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const raw of fields) {
    const { field, value } = parseFieldAssignment(raw);
    grouped.set(field, [...(grouped.get(field) ?? []), value]);
  }
  return grouped;
}

/**
 * Turn `--accept`/`--field`/`--text` into the content of an `accept` answer,
 * typed against the agent's own schema.
 *
 * `--text` is routed through the same grouping as `--field` so a one-field form
 * is read by exactly the same rules whatever flag named it.
 */
export function elicitationContentFromFlags(
  entry: PendingElicitationRequest,
  flags: { field?: string[]; text?: string; accept?: boolean },
): Record<string, PendingRequestContentValue> {
  const grouped =
    flags.text === undefined
      ? groupFieldAssignments(flags.field ?? [])
      : new Map([[soleFieldName(entry), [flags.text]]]);

  const content: Record<string, PendingRequestContentValue> = {};
  for (const [field, values] of grouped) {
    assertKnownField(entry, field);
    content[field] = coerceField(entry, field, values);
  }
  assertRequiredFieldsPresent(entry, content);
  return content;
}
