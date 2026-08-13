export type SessionEffortState = {
  configId: string;
  currentEffort: string;
  availableEfforts: Array<{
    effort: string;
    name: string;
  }>;
};

type EffortInspection =
  | { kind: "supported"; state: SessionEffortState }
  | { kind: "missing" }
  | { kind: "invalid"; configId: string };

const FALLBACK_EFFORT_CONFIG_IDS = new Set([
  "reasoning_effort",
  "effort",
  "thought_level",
  "thinking",
  "thinking_level",
]);

export const REQUESTED_EFFORT_UNSUPPORTED_ERROR_CODE = "ACP_EFFORT_UNSUPPORTED" as const;

export type RequestedEffortUnsupportedErrorCode = typeof REQUESTED_EFFORT_UNSUPPORTED_ERROR_CODE;

export const REQUESTED_EFFORT_UNSUPPORTED_REASONS = [
  "missing-capability",
  "invalid-capability",
  "unadvertised-effort",
] as const;

export type RequestedEffortUnsupportedReason =
  (typeof REQUESTED_EFFORT_UNSUPPORTED_REASONS)[number];

export class RequestedEffortUnsupportedError extends Error {
  readonly code = REQUESTED_EFFORT_UNSUPPORTED_ERROR_CODE;
  readonly reason: RequestedEffortUnsupportedReason;

  constructor(message: string, reason: RequestedEffortUnsupportedReason) {
    super(message);
    this.name = "RequestedEffortUnsupportedError";
    this.reason = reason;
  }
}

function isRequestedEffortUnsupportedReason(
  value: unknown,
): value is RequestedEffortUnsupportedReason {
  return (
    typeof value === "string" &&
    REQUESTED_EFFORT_UNSUPPORTED_REASONS.includes(value as RequestedEffortUnsupportedReason)
  );
}

export function isRequestedEffortUnsupportedError(
  value: unknown,
): value is RequestedEffortUnsupportedError {
  if (value instanceof RequestedEffortUnsupportedError) {
    return true;
  }
  const candidate = asRecord(value);
  return (
    candidate?.name === "RequestedEffortUnsupportedError" &&
    candidate.code === REQUESTED_EFFORT_UNSUPPORTED_ERROR_CODE &&
    isRequestedEffortUnsupportedReason(candidate.reason)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type AvailableEffort = SessionEffortState["availableEfforts"][number];

function parseEffort(value: unknown): AvailableEffort | undefined {
  const option = asRecord(value);
  return option && typeof option.value === "string" && typeof option.name === "string"
    ? { effort: option.value, name: option.name }
    : undefined;
}

function parseEffortGroup(value: unknown): AvailableEffort[] | undefined {
  const group = asRecord(value);
  if (!group || !Array.isArray(group.options)) {
    return undefined;
  }
  const efforts = group.options.map(parseEffort);
  return efforts.every((effort): effort is AvailableEffort => effort !== undefined)
    ? efforts
    : undefined;
}

function parseEfforts(value: unknown): AvailableEffort[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const direct = value.map(parseEffort);
  if (direct.every((effort): effort is AvailableEffort => effort !== undefined)) {
    return direct;
  }
  const grouped = value.map(parseEffortGroup);
  return grouped.every((efforts): efforts is AvailableEffort[] => efforts !== undefined)
    ? grouped.flat()
    : undefined;
}

function parseEffortState(value: unknown): SessionEffortState | undefined {
  const option = asRecord(value);
  if (
    !option ||
    option.type !== "select" ||
    typeof option.id !== "string" ||
    typeof option.currentValue !== "string"
  ) {
    return undefined;
  }
  const availableEfforts = parseEfforts(option.options);
  if (!availableEfforts || availableEfforts.length === 0) {
    return undefined;
  }
  return {
    configId: option.id,
    currentEffort: option.currentValue,
    availableEfforts,
  };
}

function matchingCandidates(configOptions: unknown): unknown[] {
  if (!Array.isArray(configOptions)) {
    return [];
  }
  // The ACP Session Config Options RFD makes configOptions order the priority
  // and tie-break for duplicate categories. Keep that order instead of
  // reranking categorized options by adapter-specific ids.
  const categorized = configOptions.filter(
    (value) => asRecord(value)?.category === "thought_level",
  );
  if (categorized.length > 0) {
    return categorized;
  }
  return configOptions.filter((value) => {
    const id = asRecord(value)?.id;
    return typeof id === "string" && FALLBACK_EFFORT_CONFIG_IDS.has(id);
  });
}

function candidateId(value: unknown): string {
  const id = asRecord(value)?.id;
  return typeof id === "string" && id.trim().length > 0 ? id : "unknown";
}

function inspectEffortConfigOptions(configOptions: unknown): EffortInspection {
  const candidates = matchingCandidates(configOptions);
  if (candidates.length === 0) {
    return { kind: "missing" };
  }
  for (const candidate of candidates) {
    const state = parseEffortState(candidate);
    if (state) {
      return { kind: "supported", state };
    }
  }
  return { kind: "invalid", configId: candidateId(candidates[0]) };
}

export function effortStateFromConfigOptions(
  configOptions: unknown,
): SessionEffortState | undefined {
  const inspected = inspectEffortConfigOptions(configOptions);
  return inspected.kind === "supported" ? inspected.state : undefined;
}

export function formatAvailableEfforts(state: SessionEffortState): string {
  const efforts = state.availableEfforts
    .map((option) => option.effort.trim())
    .filter((effort) => effort.length > 0);
  return efforts.length > 0 ? efforts.join(", ") : "none advertised";
}

function modelDescription(modelId: string | undefined): string {
  const normalized = typeof modelId === "string" ? modelId.trim() : "";
  return normalized || "the adapter default model";
}

export function assertRequestedEffortSupported(params: {
  requestedEffort: string;
  configOptions: unknown;
  modelId?: string;
}): SessionEffortState {
  const model = modelDescription(params.modelId);
  const inspected = inspectEffortConfigOptions(params.configOptions);
  if (inspected.kind === "missing") {
    throw new RequestedEffortUnsupportedError(
      `Cannot apply --effort "${params.requestedEffort}" for model "${model}": the ACP agent did not advertise a thought-level session config option.`,
      "missing-capability",
    );
  }
  if (inspected.kind === "invalid") {
    throw new RequestedEffortUnsupportedError(
      `Cannot apply --effort "${params.requestedEffort}" for model "${model}": ACP config option "${inspected.configId}" is not a usable select option with advertised values.`,
      "invalid-capability",
    );
  }

  if (
    !inspected.state.availableEfforts.some((option) => option.effort === params.requestedEffort)
  ) {
    throw new RequestedEffortUnsupportedError(
      `Cannot apply --effort "${params.requestedEffort}" for model "${model}": the ACP agent did not advertise that effort. Available efforts: ${formatAvailableEfforts(inspected.state)}.`,
      "unadvertised-effort",
    );
  }
  return inspected.state;
}
