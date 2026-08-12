import type { TranscriptEvent } from "./types";

export interface WireTimelineEvent {
  readonly schema: "acpx.session_event.v1";
  readonly kind?: never;
  readonly seq: number;
  readonly captured_at: string;
  readonly direction: "inbound" | "outbound" | "internal";
  readonly turn_id?: string;
  readonly request_id?: string;
  readonly payload: unknown;
}

export interface WireTimelineGap {
  readonly schema: "acpx.session_history_gap.v1";
  readonly kind: "history_gap";
  readonly reason: "legacy_retained";
  readonly message: string;
}

export type WireTimelineItem = WireTimelineEvent | WireTimelineGap;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const contentText = (value: unknown): string | undefined => {
  const content = asRecord(value);
  if (content.type === "text") {
    return asString(content.text);
  }
  if (content.type === "resource_link") {
    return asString(content.title) ?? asString(content.name) ?? asString(content.uri);
  }
  if (content.type === "resource") {
    const resource = asRecord(content.resource);
    return asString(resource.text) ?? asString(resource.uri);
  }
  if (content.type === "image") {
    return `[image${asString(content.mimeType) ? `: ${String(content.mimeType)}` : ""}]`;
  }
  if (content.type === "audio") {
    return `[audio${asString(content.mimeType) ? `: ${String(content.mimeType)}` : ""}]`;
  }
  return undefined;
};

const promptText = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  const direct = contentText(value);
  if (direct !== undefined) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.flatMap((part) => {
    const text = contentText(part);
    return text === undefined ? [] : [text];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
};

const baseEvent = (
  event: WireTimelineEvent,
): Pick<
  TranscriptEvent,
  "id" | "sequence" | "occurredAt" | "direction" | "turnId" | "requestId" | "payload"
> => ({
  id: `event:${event.seq}`,
  sequence: event.seq,
  occurredAt: event.captured_at,
  direction:
    event.direction === "inbound"
      ? "agent_to_client"
      : event.direction === "outbound"
        ? "client_to_agent"
        : "internal",
  turnId: event.turn_id,
  requestId: event.request_id,
  payload: event.payload,
});

const projectSessionUpdate = (
  event: WireTimelineEvent,
  update: Record<string, unknown>,
): TranscriptEvent => {
  const base = baseEvent(event);
  const updateKind = asString(update.sessionUpdate) ?? "unknown_update";
  if (updateKind === "agent_message_chunk" || updateKind === "user_message_chunk") {
    return {
      ...base,
      kind: "message",
      role: updateKind === "user_message_chunk" ? "user" : "assistant",
      text: contentText(update.content) ?? "",
      status: "streaming",
    };
  }
  if (updateKind === "agent_thought_chunk") {
    return {
      ...base,
      kind: "reasoning",
      role: "assistant",
      text: contentText(update.content) ?? "",
      status: "streaming",
    };
  }
  if (updateKind === "tool_call" || updateKind === "tool_call_update") {
    const toolCallId = asString(update.toolCallId) ?? event.request_id ?? `tool:${event.seq}`;
    return {
      ...base,
      id: `tool:${toolCallId}:${event.seq}`,
      requestId: toolCallId,
      kind: "tool_call",
      role: "assistant",
      title: asString(update.title) ?? asString(update.kind),
      toolName: asString(update.kind) ?? asString(update.title),
      status: asString(update.status) ?? (updateKind === "tool_call" ? "in_progress" : undefined),
      input: update.rawInput,
      output: update.rawOutput ?? update.content,
    };
  }
  return {
    ...base,
    kind: updateKind,
    role: "assistant",
    title: updateKind.replaceAll("_", " "),
    status: "complete",
    input: update,
  };
};

const projectAcpEnvelope = (
  event: WireTimelineEvent,
  message: Record<string, unknown>,
): TranscriptEvent => {
  const base = baseEvent(event);
  const method = asString(message.method) ?? "acp_event";
  const params = asRecord(message.params);

  if (method === "session/prompt") {
    return {
      ...base,
      kind: "message",
      role: "user",
      text: promptText(params.prompt) ?? asString(params.text) ?? "",
      status: "complete",
    };
  }
  if (method === "session/update") {
    return projectSessionUpdate(event, asRecord(params.update));
  }
  if (method === "session/request_permission") {
    const toolCall = asRecord(params.toolCall);
    return {
      ...base,
      kind: "permission",
      role: "assistant",
      title: asString(toolCall.title) ?? "Permission request",
      status: "pending",
      input: params,
    };
  }
  if (method === "elicitation/create") {
    return {
      ...base,
      kind: "elicitation",
      role: "assistant",
      title: asString(params.message) ?? "Agent question",
      status: "pending",
      input: params,
    };
  }
  return {
    ...base,
    kind: method,
    role: event.direction === "outbound" ? "user" : "assistant",
    title: method,
    status: "complete",
    input: params,
    output: message.result,
  };
};

const projectLifecycle = (
  event: WireTimelineEvent,
  lifecycle: Record<string, unknown>,
): TranscriptEvent => {
  const type = asString(lifecycle.type) ?? "lifecycle";
  return {
    ...baseEvent(event),
    kind: "lifecycle",
    role: "assistant",
    title: type.replace(/^turn_/u, "Turn ").replaceAll("_", " "),
    status: type.replace(/^turn_/u, ""),
    input: lifecycle,
  };
};

export const projectTimelineEvent = (event: WireTimelineEvent): TranscriptEvent => {
  const payload = asRecord(event.payload);
  if (payload.kind === "acp") {
    return projectAcpEnvelope(event, asRecord(payload.message));
  }
  if (payload.kind === "lifecycle") {
    return projectLifecycle(event, asRecord(payload.event));
  }
  return {
    ...baseEvent(event),
    kind: "unknown",
    role: event.direction === "outbound" ? "user" : "assistant",
    title: "Unknown ACP event",
    status: "complete",
    input: event.payload,
  };
};

const sameTextStream = (left: TranscriptEvent, right: TranscriptEvent): boolean =>
  left.kind === right.kind &&
  (left.kind === "message" || left.kind === "reasoning") &&
  left.role === right.role &&
  left.turnId === right.turnId;

/** Coalesce streaming chunks across page boundaries without disturbing activity chronology. */
export const coalesceTranscriptEvents = (
  events: readonly TranscriptEvent[],
): readonly TranscriptEvent[] => {
  const sourceEvents = events.flatMap((event) => event.sourceEvents ?? [event]);
  const ordered = [...new Map(sourceEvents.map((event) => [event.id, event])).values()].toSorted(
    (left, right) =>
      left.sequence - right.sequence || left.occurredAt.localeCompare(right.occurredAt),
  );
  const result: TranscriptEvent[] = [];
  const toolIndex = new Map<string, number>();
  for (const event of ordered) {
    const previous = result.at(-1);
    if (previous && sameTextStream(previous, event)) {
      result[result.length - 1] = {
        ...previous,
        text: `${previous.text ?? ""}${event.text ?? ""}`,
        status: event.status,
        sourceEvents: [
          ...(previous.sourceEvents ?? [previous]),
          ...(event.sourceEvents ?? [event]),
        ],
        payload: [previous.payload, event.payload],
      };
      continue;
    }
    if (event.kind === "tool_call" && event.requestId) {
      const index = toolIndex.get(event.requestId);
      if (index !== undefined) {
        const original = result[index];
        result[index] = {
          ...original,
          title: event.title ?? original.title,
          toolName: event.toolName ?? original.toolName,
          status: event.status ?? original.status,
          sourceEvents: [
            ...(original.sourceEvents ?? [original]),
            ...(event.sourceEvents ?? [event]),
          ],
          input: event.input ?? original.input,
          output: event.output ?? original.output,
          payload: [original.payload, event.payload],
        };
        continue;
      }
      toolIndex.set(event.requestId, result.length);
    }
    result.push(event);
  }
  return result;
};

/**
 * Bind one authoritative request card to its first chronological event.
 * Later created/answered/cancelled transition envelopes stay in the lossless
 * timeline but do not duplicate the interactive card.
 */
export const firstInteractionEventIds = (
  events: readonly TranscriptEvent[],
): ReadonlyMap<string, string> => {
  const result = new Map<string, string>();
  for (const event of [...events].toSorted((left, right) => left.sequence - right.sequence)) {
    if (event.requestId && !result.has(event.requestId)) {
      result.set(event.requestId, event.id);
    }
  }
  return result;
};

export const timelineActivityToolName = (
  event: TranscriptEvent,
  interactionRequestId?: string,
): string => {
  if (interactionRequestId) {
    return `acpx:interaction:${interactionRequestId}`;
  }
  if (event.kind === "reasoning" || event.kind === "plan") {
    return `acpx:${event.kind}`;
  }
  return event.toolName ?? event.title ?? `acpx:${event.kind}`;
};

export const timelineEventIsRunning = (event: TranscriptEvent): boolean =>
  ["pending", "in_progress", "running", "streaming"].includes(event.status ?? "");

export const normalizeHistoricalStreamingEvent = (
  event: TranscriptEvent,
  activeTurnId: string | undefined,
): TranscriptEvent =>
  event.status === "streaming" && (!activeTurnId || event.turnId !== activeTurnId)
    ? { ...event, status: "complete" }
    : event;
