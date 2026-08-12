import {
  AssistantRuntimeProvider,
  type AppendMessage,
  type ExternalThreadQueueAdapter,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { type ReactNode, useCallback, useMemo } from "react";
import { useSessionStore } from "./session-store";
import {
  firstInteractionEventIds,
  normalizeHistoricalRunningEvent,
  timelineActivityToolName,
  timelineEventIsRunning,
} from "./timeline-projector";
import type { PendingInteraction, TranscriptEvent } from "./types";
import { consumeUiAction } from "./ui-actions";

export interface TimelineMessage {
  readonly event: TranscriptEvent;
  readonly interaction?: PendingInteraction;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

const jsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map(jsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") {
    return value.description ?? "symbol";
  }
  return typeof value === "function" ? "[function]" : null;
};

const record = (value: unknown): { readonly [key: string]: JsonValue } => {
  const normalized = jsonValue(value);
  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized
    : { value: normalized };
};

const convertTimelineMessage = ({ event, interaction }: TimelineMessage): ThreadMessageLike => {
  const role = event.role === "user" ? "user" : "assistant";
  const hasActivity =
    interaction !== undefined || (event.kind !== "message" && event.kind !== "text");
  const content: Exclude<ThreadMessageLike["content"], string> = hasActivity
    ? [
        {
          type: "tool-call",
          toolCallId: event.requestId ?? event.id,
          toolName: timelineActivityToolName(event, interaction?.id),
          args: record(interaction ?? event.input ?? event.payload),
          argsText: JSON.stringify(interaction ?? event.input ?? event.payload ?? {}, null, 2),
          result: event.output,
          isError: event.status === "failed",
        },
      ]
    : [{ type: "text", text: event.text ?? "" }];
  const incomplete = timelineEventIsRunning(event)
    ? { type: "running" as const }
    : event.status === "failed"
      ? {
          type: "incomplete" as const,
          reason: "error" as const,
          error: event.text ?? "Activity failed",
        }
      : event.status === "cancelled" || event.status === "interrupted"
        ? { type: "incomplete" as const, reason: "cancelled" as const }
        : { type: "complete" as const, reason: "stop" as const };

  return {
    id: event.id,
    role,
    content,
    createdAt: new Date(event.occurredAt),
    ...(role === "assistant" ? { status: incomplete } : {}),
    metadata: {
      custom: {
        eventKind: event.kind,
        eventStatus: event.status,
        sequence: event.sequence,
        title: event.title,
        turnId: event.turnId,
        requestId: event.requestId,
        raw: event.payload,
      },
    },
  };
};

const appendText = (message: AppendMessage): string =>
  message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();

const BUSY_TURN_STATES = new Set([
  "queued",
  "starting",
  "running",
  "waiting_permission",
  "waiting_elicitation",
  "cancelling",
]);

export function AcpxRuntimeProvider({ children }: { readonly children: ReactNode }) {
  const store = useSessionStore();
  const isRunning = store.selectedSession
    ? BUSY_TURN_STATES.has(store.selectedSession.turnState)
    : false;
  const interactionById = useMemo(
    () => new Map(store.pending.map((interaction) => [interaction.id, interaction])),
    [store.pending],
  );
  const messages = useMemo<readonly TimelineMessage[]>(() => {
    const timeline = store.timeline?.events ?? [];
    const covered = new Set(
      timeline.flatMap((event) => (event.requestId ? [event.requestId] : [])),
    );
    const synthetic = store.pending
      .filter((interaction) => !covered.has(interaction.id))
      .map(
        (interaction, index): TranscriptEvent => ({
          id: `pending:${interaction.id}`,
          sequence: Number.MAX_SAFE_INTEGER - store.pending.length + index,
          occurredAt: interaction.createdAt,
          requestId: interaction.id,
          kind: interaction.kind,
          role: "assistant",
          title: interaction.title,
          status: interaction.state,
          payload: interaction,
        }),
      );
    const allEvents = [...timeline, ...synthetic].toSorted(
      (left, right) =>
        left.sequence - right.sequence || left.occurredAt.localeCompare(right.occurredAt),
    );
    const firstByRequest = firstInteractionEventIds(allEvents);
    return allEvents.map((event) => {
      const interaction =
        event.requestId && firstByRequest.get(event.requestId) === event.id
          ? interactionById.get(event.requestId)
          : undefined;
      let normalized =
        interaction?.state === "pending"
          ? event
          : normalizeHistoricalRunningEvent(
              event,
              isRunning ? store.selectedSession?.activeTurnId : undefined,
            );
      if (
        (event.kind === "permission" || event.kind === "elicitation") &&
        (!interaction || interaction.state !== "pending") &&
        timelineEventIsRunning(normalized)
      ) {
        normalized = { ...normalized, status: "complete" };
      }
      return { event: normalized, interaction };
    });
  }, [
    interactionById,
    isRunning,
    store.pending,
    store.selectedSession?.activeTurnId,
    store.timeline?.events,
  ]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = appendText(message);
      if (!text) {
        return;
      }
      await store.sendPrompt(text);
    },
    [store],
  );

  const queue = useMemo<ExternalThreadQueueAdapter | undefined>(
    () =>
      isRunning
        ? {
            items: store.queuedPrompts.map((prompt) => ({
              id: prompt.id,
              prompt: prompt.text,
              parts: [{ type: "text" as const, text: prompt.text }],
            })),
            steerItems: [],
            enqueue: (message) => consumeUiAction(onNew(message)),
            steer: (message) => consumeUiAction(onNew(message)),
            move: () => {
              throw new Error("Reordering queued ACPX prompts is not supported.");
            },
            edit: () => {
              throw new Error("Editing queued ACPX prompts is not supported.");
            },
            remove: () => {
              throw new Error("Removing queued ACPX prompts is not supported.");
            },
          }
        : undefined,
    [isRunning, onNew, store.queuedPrompts],
  );

  const runtime = useExternalStoreRuntime<TimelineMessage>({
    messages,
    convertMessage: convertTimelineMessage,
    isLoading: store.selectedSessionId !== null && store.timeline === null,
    isRunning,
    isDisabled: store.selectedSession === null || store.selectedSession.sessionState === "closed",
    isSendDisabled: store.actionBusy,
    onNew,
    onCancel: store.cancelTurn,
    queue,
    unstable_capabilities: { copy: true },
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
