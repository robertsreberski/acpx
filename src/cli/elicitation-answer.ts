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

function coerceNumber(field: string, value: string, integer: boolean): number {
  const trimmed = value.trim();
  const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    throw new InvalidArgumentError(
      `Field ${field} is ${integer ? "an integer" : "a number"}; ` +
        `${JSON.stringify(value)} is not one`,
    );
  }
  return parsed;
}

/**
 * A comma-separated list. Whitespace around each item is trimmed and an empty
 * value is an empty list, so `--field picks=` selects nothing rather than
 * selecting one blank option. Items are otherwise passed through untouched,
 * including empty ones, because only the agent knows what its enum accepts.
 */
function coerceArray(value: string): string[] {
  const trimmed = value.trim();
  return trimmed === "" ? [] : trimmed.split(",").map((item) => item.trim());
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

function coerceFieldValue(
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
    case "array":
      return coerceArray(value);
    default:
      return rejectUncoercibleType(field, type);
  }
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

function contentFromFieldFlags(
  entry: PendingElicitationRequest,
  fields: string[],
): Record<string, PendingRequestContentValue> {
  const content: Record<string, PendingRequestContentValue> = {};
  for (const raw of fields) {
    const { field, value } = parseFieldAssignment(raw);
    assertKnownField(entry, field);
    if (field in content) {
      // Last-one-wins would silently discard one of two answers the operator
      // deliberately typed, and there is no way to tell which they meant.
      throw new InvalidArgumentError(`--field ${field} was given more than once`);
    }
    content[field] = coerceFieldValue(entry, field, value);
  }
  return content;
}

/**
 * Turn `--field`/`--text` into the content of an `accept` answer, typed against
 * the agent's own schema.
 */
export function elicitationContentFromFlags(
  entry: PendingElicitationRequest,
  flags: { field?: string[]; text?: string },
): Record<string, PendingRequestContentValue> {
  const content =
    flags.text === undefined
      ? contentFromFieldFlags(entry, flags.field ?? [])
      : { [soleFieldName(entry)]: coerceFieldValue(entry, soleFieldName(entry), flags.text) };
  assertRequiredFieldsPresent(entry, content);
  return content;
}
