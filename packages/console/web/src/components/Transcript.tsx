import {
  ComposerPrimitive,
  MessagePrimitive,
  type TextMessagePartProps,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { type FormEvent, useMemo, useState } from "react";
import { booleanElicitationChoices, readElicitationField } from "../elicitation";
import { interactionAvailability } from "../interaction-availability";
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
      <h3>{interaction.title}</h3>
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
      value: String(choice.const),
      label: choice.title ?? String(choice.const),
    }));
  }
  if (property.enum) {
    return property.enum.map((choice) => ({ value: String(choice), label: String(choice) }));
  }
  if (property.items?.oneOf) {
    return property.items.oneOf.map((choice) => ({
      value: String(choice.const),
      label: choice.title ?? String(choice.const),
    }));
  }
  if (property.items?.enum) {
    return property.items.enum.map((choice) => ({ value: String(choice), label: String(choice) }));
  }
  return [];
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
        <select name={name} required={required} defaultValue="">
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
            <input type="checkbox" name={name} value={choice.value} />
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
        <select name={name} required={required} defaultValue="">
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
          type={property.type === "number" || property.type === "integer" ? "number" : "text"}
          step={property.type === "integer" ? "1" : undefined}
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
      <h3>{elicitation?.message ?? interaction.title}</h3>
      {availability.reason && (
        <p className="interaction-unavailable" role="note">
          {availability.reason}
        </p>
      )}
      {interaction.state === "pending" && (
        <form onSubmit={submit}>
          {fields.map(([name, property]) => (
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
              disabled={actionBusy || !availability.answerable}
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
  return (
    <ThreadPrimitive.Root className="thread-root">
      <ThreadPrimitive.Viewport className="thread-viewport">
        <div className="timeline-boundary">
          {store.timeline?.previousCursor && (
            <button type="button" className="load-earlier" onClick={() => void store.loadEarlier()}>
              Load earlier
            </button>
          )}
          {(store.timeline?.coverage === "legacy_retained" || store.timeline?.gap) && (
            <div className="history-gap" role="note">
              Some earlier history predates lossless capture. The retained transcript begins here.
            </div>
          )}
        </div>
        <ThreadPrimitive.Empty>
          <div className="empty-thread">
            <div className="empty-thread-mark">
              <Icon name="spark" size={25} />
            </div>
            <h2>Ready for a prompt</h2>
            <p>This session’s complete ACP transcript will appear here as it happens.</p>
          </div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
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
          <ComposerPrimitive.Root className="composer">
            <ComposerPrimitive.Input
              className="composer-input"
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
              <ComposerPrimitive.Send
                className="composer-send"
                disabled={store.actionBusy}
                aria-label={sendLabel}
              >
                <span>{sendLabel}</span>
                <Icon name="send" size={16} />
              </ComposerPrimitive.Send>
            </div>
          </ComposerPrimitive.Root>
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
