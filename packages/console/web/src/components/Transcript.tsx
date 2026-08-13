import {
  MessagePrimitive,
  type TextMessagePartProps,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { shouldSubmitComposerKey } from "../composer-submit";
import { booleanElicitationChoices, readElicitationField } from "../elicitation";
import { interactionAvailability } from "../interaction-availability";
import { unavailableQueuedControlsMessage } from "../queued-prompts";
import { useSessionStore } from "../session-store";
import type { ElicitationProperty, PendingInteraction } from "../types";
import { consumeUiAction } from "../ui-actions";
import { Icon } from "./Icon";

const jsonText = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
};

function TranscriptText(_props: TextMessagePartProps) {
  return <MarkdownTextPrimitive className="message-text" />;
}

const interactionIdFromToolName = (toolName: string): string | undefined =>
  toolName.startsWith("acpx:interaction:") ? toolName.slice("acpx:interaction:".length) : undefined;

function PermissionCard({ interaction }: { readonly interaction: PendingInteraction }) {
  const { answerInteraction, actionBusy, selectedSession } = useSessionStore();
  const availability = interactionAvailability(interaction, selectedSession?.ownerState);
  return (
    <section
      className={`interaction-card permission-card is-${interaction.state}`}
      aria-label="Permission request"
    >
      <header>
        <span className="interaction-kicker">Permission request</span>
        <span className={`interaction-state is-${interaction.state}`}>{interaction.state}</span>
      </header>
      <h2>{interaction.title}</h2>
      {interaction.detail && <p>{interaction.detail}</p>}
      {availability.reason && (
        <p className="interaction-unavailable" role="note">
          {availability.reason}
        </p>
      )}
      {interaction.state === "pending" && (
        <div className="interaction-actions">
          {interaction.options?.map((option) => (
            <button
              type="button"
              key={option.id}
              className={option.kind?.startsWith("allow") ? "approve-button" : "secondary-button"}
              disabled={actionBusy || !availability.answerable}
              onClick={() =>
                consumeUiAction(
                  answerInteraction(interaction.id, { type: "select", option_id: option.id }),
                )
              }
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            className="secondary-button"
            disabled={actionBusy || !availability.answerable}
            onClick={() => consumeUiAction(answerInteraction(interaction.id, { type: "decline" }))}
          >
            Decline
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={actionBusy || !availability.answerable}
            onClick={() => consumeUiAction(answerInteraction(interaction.id, { type: "cancel" }))}
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}

const choicesFor = (property: ElicitationProperty): readonly { value: string; label: string }[] => {
  if (property.oneOf) {
    return property.oneOf.map((choice) => ({
      value: choice.const,
      label: choice.title ?? choice.const,
    }));
  }
  if (property.enum) {
    return property.enum.map((choice) => ({ value: choice, label: choice }));
  }
  if (property.anyOf) {
    return property.anyOf.map((choice) => ({
      value: choice.const,
      label: choice.title ?? choice.const,
    }));
  }
  if (property.items?.anyOf) {
    return property.items.anyOf.map((choice) => ({
      value: choice.const,
      label: choice.title ?? choice.const,
    }));
  }
  if (property.items?.enum) {
    return property.items.enum.map((choice) => ({ value: choice, label: choice }));
  }
  return [];
};

const SUPPORTED_ELICITATION_TYPES = new Set(["string", "number", "integer", "boolean", "array"]);
const SUPPORTED_ELICITATION_FORMATS = new Set(["email", "uri", "date", "date-time"]);

const unsupportedFieldReason = (property: ElicitationProperty): string | undefined => {
  if (property.type !== undefined && !SUPPORTED_ELICITATION_TYPES.has(property.type)) {
    return `Unsupported field type “${property.type}”.`;
  }
  if (property.type === "array" && choicesFor(property).length === 0) {
    return "This multi-select has no supported ACP choices.";
  }
  if (property.format != null && !SUPPORTED_ELICITATION_FORMATS.has(property.format)) {
    return `Unsupported field format “${property.format}”.`;
  }
  if (typeof property.pattern === "string") {
    return "Agent validation patterns are not supported safely in the console.";
  }
  return undefined;
};

const inputTypeFor = (property: ElicitationProperty): string => {
  if (property.type === "number" || property.type === "integer") {
    return "number";
  }
  if (property.format === "email") {
    return "email";
  }
  if (property.format === "uri") {
    return "url";
  }
  if (property.format === "date") {
    return "date";
  }
  if (property.format === "date-time") {
    return "datetime-local";
  }
  return "text";
};

function ElicitationField({
  name,
  property,
  required,
}: {
  readonly name: string;
  readonly property: ElicitationProperty;
  readonly required: boolean;
}) {
  const choices = choicesFor(property);
  const label = property.title ?? name.replaceAll("_", " ");
  if (property.type === "boolean") {
    return (
      <label className="elicitation-field">
        <span>
          {label}
          {required ? " *" : ""}
        </span>
        <select
          name={name}
          required={required}
          defaultValue={typeof property.default === "boolean" ? String(property.default) : ""}
        >
          {booleanElicitationChoices(required).map((choice) => (
            <option key={choice.value} value={choice.value} disabled={choice.disabled}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (property.type === "array") {
    return (
      <fieldset className="elicitation-field">
        <legend>
          {label}
          {required ? " *" : ""}
        </legend>
        {property.description && <p>{property.description}</p>}
        {choices.map((choice) => (
          <label className="form-check" key={choice.value}>
            <input
              type="checkbox"
              name={name}
              value={choice.value}
              defaultChecked={
                Array.isArray(property.default) && property.default.includes(choice.value)
              }
            />
            <span>{choice.label}</span>
          </label>
        ))}
      </fieldset>
    );
  }
  return (
    <label className="elicitation-field">
      <span>
        {label}
        {required ? " *" : ""}
      </span>
      {property.description && <small>{property.description}</small>}
      {choices.length > 0 ? (
        <select name={name} required={required} defaultValue={String(property.default ?? "")}>
          <option value="" disabled>
            Select…
          </option>
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          name={name}
          required={required}
          type={inputTypeFor(property)}
          step={property.type === "integer" ? "1" : undefined}
          min={property.minimum ?? undefined}
          max={property.maximum ?? undefined}
          minLength={property.minLength ?? undefined}
          maxLength={property.maxLength ?? undefined}
          defaultValue={
            typeof property.default === "string" || typeof property.default === "number"
              ? property.default
              : undefined
          }
        />
      )}
    </label>
  );
}

function ElicitationCard({ interaction }: { readonly interaction: PendingInteraction }) {
  const { answerInteraction, actionBusy, selectedSession } = useSessionStore();
  const [error, setError] = useState<string | null>(null);
  const elicitation = interaction.elicitation;
  const fields = Object.entries(elicitation?.properties ?? {});
  const required = useMemo(() => new Set(elicitation?.required ?? []), [elicitation?.required]);
  const availability = interactionAvailability(interaction, selectedSession?.ownerState);
  const unsupported = fields
    .map(([name, property]) => {
      const reason = unsupportedFieldReason(property);
      return reason ? `${property.title ?? name}: ${reason}` : undefined;
    })
    .find((reason) => reason !== undefined);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const content: Record<string, unknown> = {};
    for (const [name, property] of fields) {
      const values = data.getAll(name);
      let result: ReturnType<typeof readElicitationField>;
      try {
        result = readElicitationField(property, values, required.has(name));
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : `Could not read ${property.title ?? name}.`,
        );
        return;
      }
      if (result.kind === "missing") {
        setError(`${property.title ?? name} is required.`);
        return;
      }
      if (result.kind === "omitted") {
        continue;
      }
      content[name] = result.value;
    }
    setError(null);
    consumeUiAction(answerInteraction(interaction.id, { type: "accept", content }));
  };

  return (
    <section
      className={`interaction-card elicitation-card is-${interaction.state}`}
      aria-label="Agent question"
    >
      <header>
        <span className="interaction-kicker">Agent question</span>
        <span className={`interaction-state is-${interaction.state}`}>{interaction.state}</span>
      </header>
      <h2>{elicitation?.message ?? interaction.title}</h2>
      {availability.reason && (
        <p className="interaction-unavailable" role="note">
          {availability.reason}
        </p>
      )}
      {unsupported && (
        <p className="interaction-unavailable" role="alert">
          This form cannot be answered safely here. {unsupported} Decline or cancel it instead.
        </p>
      )}
      {interaction.state === "pending" && (
        <form onSubmit={submit}>
          {!unsupported &&
            fields.map(([name, property]) => (
              <ElicitationField
                key={name}
                name={name}
                property={property}
                required={required.has(name)}
              />
            ))}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="interaction-actions">
            <button
              type="submit"
              className="approve-button"
              disabled={actionBusy || !availability.answerable || unsupported !== undefined}
            >
              Accept
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={actionBusy || !availability.answerable}
              onClick={() =>
                consumeUiAction(answerInteraction(interaction.id, { type: "decline" }))
              }
            >
              Decline
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={actionBusy || !availability.answerable}
              onClick={() => consumeUiAction(answerInteraction(interaction.id, { type: "cancel" }))}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function ActivityTool({
  toolName,
  toolCallId,
  args,
  result,
  isError,
  status,
}: ToolCallMessagePartProps) {
  const { pending } = useSessionStore();
  const interactionId = interactionIdFromToolName(toolName);
  const interaction = interactionId ? pending.find((item) => item.id === interactionId) : undefined;
  if (interaction?.kind === "permission") {
    return <PermissionCard interaction={interaction} />;
  }
  if (interaction?.kind === "elicitation") {
    return <ElicitationCard interaction={interaction} />;
  }

  const running = status.type === "running";
  const title = toolName.startsWith("acpx:") ? toolName.slice(5).replaceAll("_", " ") : toolName;
  return (
    <details className={`activity-card${isError ? " is-error" : ""}`} open={running}>
      <summary>
        <span className={`activity-indicator${running ? " is-running" : ""}`} />
        <strong>{title}</strong>
        <span>{running ? "active" : isError ? "failed" : "complete"}</span>
        <Icon name="chevron" size={15} />
      </summary>
      <div className="activity-payload">
        <div>
          <span>Input</span>
          <pre>{jsonText(args)}</pre>
        </div>
        {result !== undefined && (
          <div>
            <span>Output</span>
            <pre>{jsonText(result)}</pre>
          </div>
        )}
        <details className="raw-disclosure">
          <summary>Raw event</summary>
          <pre>{jsonText({ toolCallId, toolName, args, result, status })}</pre>
        </details>
      </div>
    </details>
  );
}

const MESSAGE_COMPONENTS = { Text: TranscriptText, tools: { Fallback: ActivityTool } };

function UserMessage() {
  return (
    <MessagePrimitive.Root className="message-row is-user">
      <div className="message-author">You</div>
      <div className="message-bubble">
        <MessagePrimitive.Parts components={MESSAGE_COMPONENTS} />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message-row is-assistant">
      <div className="message-author">Agent</div>
      <div className="message-bubble">
        <MessagePrimitive.Parts components={MESSAGE_COMPONENTS} />
      </div>
    </MessagePrimitive.Root>
  );
}

export function Transcript() {
  const store = useSessionStore();
  const session = store.selectedSession;
  const isBusy =
    session &&
    !["idle", "completed", "failed", "cancelled", "interrupted", "unknown"].includes(
      session.turnState,
    );
  const sendLabel = isBusy ? "Queue follow-up" : "Send prompt";
  const unavailableQueueControls = unavailableQueuedControlsMessage(
    session?.queuedCount ?? 0,
    store.queuedPrompts.length,
  );
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const composerDraft = session ? store.composerDraftFor(session.id) : "";
  const resizeComposer = () => {
    const input = composerInput.current;
    if (!input) {
      return;
    }
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  };
  useEffect(resizeComposer, [composerDraft]);
  const submitPrompt = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!session) {
      return;
    }
    const rawDraft = composerDraft;
    if (rawDraft.trim() === "") {
      return;
    }
    consumeUiAction(store.sendPrompt(rawDraft));
  };
  const composerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSubmitComposerKey(event.key, event.shiftKey, event.nativeEvent.isComposing)) {
      event.preventDefault();
      if (!store.actionBusy) {
        submitPrompt();
      }
    }
  };
  return (
    <ThreadPrimitive.Root className="thread-root">
      <ThreadPrimitive.Viewport className="thread-viewport">
        <div className="timeline-boundary">
          {store.timeline?.previousCursor && (
            <button type="button" className="load-earlier" onClick={() => void store.loadEarlier()}>
              Load earlier
            </button>
          )}
          {store.timeline?.continuityIssue && (
            <div className="history-gap is-error" role="alert">
              {store.timeline.continuityIssue.message}
            </div>
          )}
          {(store.timeline?.coverage === "incomplete" ||
            store.timeline?.gap?.reason === "corrupt") && (
            <div className="history-gap is-error" role="alert">
              {store.timeline.gap?.message ??
                "Part of the durable transcript could not be read. The visible history is incomplete."}
            </div>
          )}
          {(store.timeline?.coverage === "legacy_retained" ||
            store.timeline?.gap?.reason === "legacy_retained") && (
            <div className="history-gap" role="note">
              {store.timeline.gap?.message ??
                "Some earlier history predates lossless capture. The retained transcript begins here."}
            </div>
          )}
          {store.timeline?.writeError && (
            <div className="history-gap is-error" role="alert">
              {store.timeline.writeError}
            </div>
          )}
        </div>
        <ThreadPrimitive.Empty>
          <div className="empty-thread">
            <div className="empty-thread-mark">
              <Icon name="spark" size={25} />
            </div>
            <h2>
              {store.timeline?.legacyImportPending === true
                ? "Restoring transcript"
                : "Ready for a prompt"}
            </h2>
            <p>
              {store.timeline?.legacyImportPending === true
                ? "Loading retained history from before lossless capture. No prompt is required."
                : "This session’s complete ACP transcript will appear here as it happens."}
            </p>
          </div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        {(store.queuedPrompts.length > 0 || unavailableQueueControls) && (
          <section className="queued-prompts" aria-label="Queued follow-ups">
            <strong>Queued follow-ups</strong>
            {store.queuedPrompts.map((prompt) => (
              <div className="queued-prompt" key={prompt.id}>
                <p>{prompt.text}</p>
                <button
                  type="button"
                  className="ghost-button"
                  aria-label={`Cancel queued follow-up: ${prompt.text}`}
                  disabled={store.actionBusy}
                  onClick={() => consumeUiAction(store.cancelQueuedTurn(prompt.id))}
                >
                  Cancel
                </button>
              </div>
            ))}
            <small role={unavailableQueueControls ? "note" : undefined}>
              {unavailableQueueControls ??
                "Accepted by ACPX; they will appear in the transcript when execution starts."}
            </small>
          </section>
        )}
        <ThreadPrimitive.ScrollToBottom className="scroll-to-latest">
          Jump to latest
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.Viewport>
      {session?.sessionState === "open" && (
        <div className="composer-shell">
          {store.pending.some((item) => item.state === "pending") && (
            <p className="composer-note is-attention">
              Answer the waiting request above to unblock this turn.
            </p>
          )}
          <form className="composer" onSubmit={submitPrompt}>
            <textarea
              ref={composerInput}
              className="composer-input"
              value={composerDraft}
              onChange={(event) =>
                session && store.setComposerDraft(session.id, event.target.value)
              }
              onKeyDown={composerKeyDown}
              placeholder={
                isBusy
                  ? "Queue a follow-up for after the current turn…"
                  : "Ask the agent to work on something…"
              }
              aria-label="Prompt"
              rows={1}
            />
            <div className="composer-actions">
              {isBusy && session.activeTurnId && (
                <button
                  type="button"
                  className="composer-stop"
                  onClick={() => consumeUiAction(store.cancelTurn())}
                  disabled={store.actionBusy}
                >
                  <Icon name="stop" size={15} /> Stop
                </button>
              )}
              <button
                type="submit"
                className="composer-send"
                disabled={store.actionBusy || composerDraft.trim() === ""}
                aria-label={sendLabel}
              >
                <span>{sendLabel}</span>
                <Icon name="send" size={16} />
              </button>
            </div>
          </form>
          {isBusy && (
            <p className="composer-note">
              Queued follow-ups start after the current turn finishes.
            </p>
          )}
        </div>
      )}
    </ThreadPrimitive.Root>
  );
}
