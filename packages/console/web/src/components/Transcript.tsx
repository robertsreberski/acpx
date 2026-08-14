import {
  MessagePrimitive,
  type TextMessagePartProps,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { activityDurations, formatDuration } from "../activity-durations";
import { shouldSubmitComposerKey } from "../composer-submit";
import { dockedInteraction } from "../docked-interaction";
import { booleanElicitationChoices, readElicitationField } from "../elicitation";
import { interactionAvailability } from "../interaction-availability";
import { orderPermissionOptions } from "../permission-options";
import { unavailableQueuedControlsMessage } from "../queued-prompts";
import { distanceFromBottom, restoreScrollAnchor, scrollableAncestor } from "../scroll-anchor";
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

function PermissionRequest({ interaction }: { readonly interaction: PendingInteraction }) {
  const { answerInteraction, actionBusy, selectedSession } = useSessionStore();
  const availability = interactionAvailability(interaction, selectedSession?.ownerState);
  const { primary, secondary } = orderPermissionOptions(interaction.options);
  const disabled = actionBusy || !availability.answerable;
  const answer = (value: unknown) => consumeUiAction(answerInteraction(interaction.id, value));
  return (
    <div className="request-dock-inner">
      <div className="request-dock-copy">
        <span className="interaction-kicker">Permission request</span>
        <h2>{interaction.title}</h2>
        {interaction.detail && <p>{interaction.detail}</p>}
        {availability.reason && (
          <p className="interaction-unavailable" role="note">
            {availability.reason}
          </p>
        )}
      </div>
      {/* The primary answer leads in the DOM so keyboard and screen-reader users
          reach it first at every width; the desktop layout moves it to the end
          of the row visually. */}
      <div className="request-dock-actions">
        {primary && (
          <button
            type="button"
            className="approve-button"
            disabled={disabled}
            onClick={() => answer({ type: "select", option_id: primary.id })}
          >
            {primary.label}
          </button>
        )}
        <div className="request-dock-secondary-row">
          {secondary.map((option) => (
            <button
              type="button"
              key={option.id}
              className="request-dock-secondary"
              disabled={disabled}
              onClick={() => answer({ type: "select", option_id: option.id })}
            >
              {option.label}
            </button>
          ))}
          {/* Protocol answers stay available but sit under the agent's own
              options, which are the ones it actually offered. */}
          <button
            type="button"
            className="request-dock-secondary is-quiet"
            disabled={disabled}
            onClick={() => answer({ type: "decline" })}
          >
            Decline
          </button>
          <button
            type="button"
            className="request-dock-secondary is-quiet"
            disabled={disabled}
            onClick={() => answer({ type: "cancel" })}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ElicitationRequest({ interaction }: { readonly interaction: PendingInteraction }) {
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
  const disabled = actionBusy || !availability.answerable;

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
    <div className="request-dock-inner is-form">
      <div className="request-dock-copy">
        <span className="interaction-kicker">Agent question</span>
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
          <div className="request-dock-actions">
            <button
              type="submit"
              className="approve-button"
              disabled={disabled || unsupported !== undefined}
            >
              Accept
            </button>
            <div className="request-dock-secondary-row">
              <button
                type="button"
                className="request-dock-secondary"
                disabled={disabled}
                onClick={() =>
                  consumeUiAction(answerInteraction(interaction.id, { type: "decline" }))
                }
              >
                Decline
              </button>
              <button
                type="button"
                className="request-dock-secondary is-quiet"
                disabled={disabled}
                onClick={() =>
                  consumeUiAction(answerInteraction(interaction.id, { type: "cancel" }))
                }
              >
                Cancel
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * A turn stalls until the request is answered, so the pending card leaves the
 * scroll and docks above the composer. Only one request is docked — the design
 * treats it as the thing to deal with — and any others stay answerable in the
 * transcript rather than disappearing behind a count.
 */
function RequestDock() {
  const { pending, selectedSession } = useSessionStore();
  const docked = dockedInteraction(pending, selectedSession?.ownerState);
  if (!docked) {
    return null;
  }
  const others = pending.filter(
    (interaction) => interaction.state === "pending" && interaction.id !== docked.id,
  ).length;
  return (
    <section className="request-dock" aria-label="Waiting request">
      {/* Keyed so a following request cannot inherit the previous form's local
          error state or uncontrolled field values. */}
      {docked.kind === "permission" ? (
        <PermissionRequest key={docked.id} interaction={docked} />
      ) : (
        <ElicitationRequest key={docked.id} interaction={docked} />
      )}
      {others > 0 && (
        <p className="request-dock-count">
          {others} more waiting, {others === 1 ? "it is" : "they are"} in the transcript above.
        </p>
      )}
    </section>
  );
}

/** Answered, cancelled and expired requests stay in the transcript as history. */
function AnsweredInteraction({ interaction }: { readonly interaction: PendingInteraction }) {
  return (
    <section
      className={`interaction-card is-${interaction.state}`}
      aria-label={interaction.kind === "permission" ? "Permission request" : "Agent question"}
    >
      <header>
        <span className="interaction-kicker">
          {interaction.kind === "permission" ? "Permission request" : "Agent question"}
        </span>
        <span className={`interaction-state is-${interaction.state}`}>{interaction.state}</span>
      </header>
      <h2>{interaction.elicitation?.message ?? interaction.title}</h2>
      {interaction.detail && <p>{interaction.detail}</p>}
    </section>
  );
}

function ReasoningActivity({ durationMs }: { readonly durationMs?: number }) {
  return (
    <details className="reasoning-card">
      <summary>
        {durationMs === undefined
          ? "Thought about it"
          : `Thought for ${formatDuration(durationMs)}`}
        <Icon name="chevron" size={15} />
      </summary>
      <div className="reasoning-body">
        <MessagePrimitive.Parts components={{ Text: TranscriptText }} />
      </div>
    </details>
  );
}

function ToolActivity({
  toolName,
  toolCallId,
  args,
  result,
  isError,
  status,
  durationMs,
}: ToolCallMessagePartProps & { readonly durationMs?: number }) {
  const running = status.type === "running";
  const label = toolName.startsWith("acpx:") ? toolName.slice(5).replaceAll("_", " ") : toolName;
  const state = running
    ? "running"
    : isError
      ? "failed"
      : durationMs === undefined
        ? "done"
        : formatDuration(durationMs);
  return (
    <details
      className={`activity-card${isError ? " is-error" : ""}${running ? " is-running" : ""}`}
      open={running}
    >
      <summary>
        <span
          className={`activity-indicator${running ? " is-running" : ""}${isError ? " is-error" : ""}`}
        />
        <strong>{label}</strong>
        <span className="activity-duration">{state}</span>
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

const useTranscriptActivity = () => {
  const { pending, timeline, selectedSession } = useSessionStore();
  const durations = useMemo(() => activityDurations(timeline?.events ?? []), [timeline?.events]);
  return {
    pending,
    durations,
    dockedId: dockedInteraction(pending, selectedSession?.ownerState)?.id,
  };
};

function ActivityPart(props: ToolCallMessagePartProps) {
  const { pending, durations, dockedId } = useTranscriptActivity();
  const interactionId = interactionIdFromToolName(props.toolName);
  const interaction = interactionId ? pending.find((item) => item.id === interactionId) : undefined;
  if (interaction) {
    if (interaction.state !== "pending") {
      return <AnsweredInteraction interaction={interaction} />;
    }
    // Only the docked request leaves the scroll. Any other waiting request stays
    // here and stays answerable — the service takes responses by request id, so
    // hiding them behind the dock would make them unreachable.
    return interaction.id === dockedId ? null : (
      <section className="interaction-card is-pending" aria-label="Waiting request">
        {interaction.kind === "permission" ? (
          <PermissionRequest interaction={interaction} />
        ) : (
          <ElicitationRequest interaction={interaction} />
        )}
      </section>
    );
  }
  const durationMs = durations.get(props.toolCallId);
  if (props.toolName === "acpx:reasoning") {
    return <ReasoningActivity durationMs={durationMs} />;
  }
  return <ToolActivity {...props} durationMs={durationMs} />;
}

const MESSAGE_COMPONENTS = { Text: TranscriptText, tools: { Fallback: ActivityPart } };

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

/**
 * Page earlier history as the reader approaches the top of the transcript.
 * There is no Load earlier button by design; the viewport says quietly that it
 * is fetching and holds the reader's place across the prepend.
 */
/** Frames to wait for a prepended page to reach the DOM before giving up on it. */
const ANCHOR_FRAME_BUDGET = 90;

function useAutoLoadEarlier(
  sentinel: HTMLDivElement | null,
  canLoadEarlier: boolean,
  loadEarlier: () => Promise<void>,
): boolean {
  const loadingRef = useRef(false);
  const [loading, setLoading] = useState(false);

  /*
   * The store rebuilds `loadEarlier` whenever the timeline changes, so keeping
   * it in the effect's dependencies tears the observer down at the exact moment
   * a page lands — cancelling the anchor loop that was waiting for it. Hold the
   * latest callback in a ref instead and let the effect depend only on what it
   * actually observes.
   */
  const loadEarlierRef = useRef(loadEarlier);
  loadEarlierRef.current = loadEarlier;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!sentinel || !canLoadEarlier) {
      return undefined;
    }
    const scroller = scrollableAncestor(sentinel);
    if (!scroller) {
      return undefined;
    }
    const cancelled = () => !mountedRef.current;
    let observer: IntersectionObserver;
    /*
     * IntersectionObserver reports changes, not state. A page that failed leaves
     * the sentinel exactly where it was, so no further callback arrives and — with
     * the Load earlier button gone — earlier history becomes unreachable until the
     * reader scrolls away and back, which a short transcript may not allow.
     * Re-observing re-delivers the current intersection, after a pause so a
     * persistently failing endpoint is retried rather than hammered.
     */
    const rearm = () => {
      window.setTimeout(() => {
        if (!cancelled()) {
          observer.unobserve(sentinel);
          observer.observe(sentinel);
        }
      }, 1_000);
    };
    const settle = (landed: boolean) => {
      loadingRef.current = false;
      scroller.classList.remove("is-restoring-scroll");
      if (!cancelled()) {
        setLoading(false);
      }
      if (!landed) {
        rearm();
      }
    };

    /*
     * Hold the reader's distance from the bottom while the prepended page
     * arrives. Every growth happens above the reader, so that distance is the
     * invariant; it is re-pinned each frame rather than restored once because
     * the page does not land in a single commit. The store commits the events,
     * assistant-ui re-renders the thread from its own runtime in a later pass,
     * and the rows then grow over several frames — so both a plain
     * requestAnimationFrame and a layout effect on the timeline fire while
     * scrollHeight is still short. Anchoring against a partial height resolves
     * near the top of the transcript, which leaves the sentinel on screen and
     * pages the whole history in one burst.
     */
    const renderedRows = () => scroller.querySelectorAll(".message-row").length;

    const holdAnchor = (distance: number, rowsBefore: number) => {
      // The anchor is re-pinned by assignment every frame; with the viewport's
      // default `scroll-behavior: smooth` each of those would animate, so the
      // correction that exists to hide the prepend becomes the visible jolt.
      scroller.classList.add("is-restoring-scroll");
      let frames = 0;
      let lastHeight = scroller.scrollHeight;
      let stableFrames = 0;
      const step = () => {
        if (cancelled()) {
          return;
        }
        // Row count, not scrollHeight, decides whether the page has landed: the
        // "Loading earlier turns" line grows the container on its own, and
        // treating that as the page arriving settles the anchor a few pixels
        // from the top, which is what makes it burst.
        const landed = renderedRows() > rowsBefore;
        const height = scroller.scrollHeight;
        if (landed) {
          restoreScrollAnchor(scroller, distance);
        }
        if (height === lastHeight) {
          stableFrames += 1;
        } else {
          lastHeight = height;
          stableFrames = 0;
        }
        frames += 1;
        // Settle once the page has landed and stopped growing, or give up so a
        // request that resolved without adding anything — a rejection, or an
        // expired cursor that reloaded the head instead — cannot wedge paging.
        if ((landed && stableFrames >= 3) || frames >= ANCHOR_FRAME_BUDGET) {
          settle(landed);
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    observer = new IntersectionObserver(
      (entries) => {
        if (loadingRef.current || !entries.some((entry) => entry.isIntersecting)) {
          return;
        }
        loadingRef.current = true;
        setLoading(true);
        const distance = distanceFromBottom(scroller);
        const rowsBefore = renderedRows();
        void loadEarlierRef.current().finally(() => holdAnchor(distance, rowsBefore));
      },
      { root: scroller, rootMargin: "240px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => {
      loadingRef.current = false;
      // A teardown mid-restore never reaches settle, and leaving the class on
      // would strip smooth scrolling from the viewport for the rest of its life.
      scroller.classList.remove("is-restoring-scroll");
      observer.disconnect();
    };
  }, [sentinel, canLoadEarlier]);
  return loading;
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
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const loadingEarlier = useAutoLoadEarlier(
    sentinel,
    store.timeline?.previousCursor !== undefined,
    store.loadEarlier,
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
          <div ref={setSentinel} aria-hidden="true" />
          {loadingEarlier && (
            <p className="timeline-loading" role="status">
              <i />
              Loading earlier turns
            </p>
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
              <Icon name="spark" size={26} />
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
      <RequestDock />
      {session?.sessionState === "open" && (
        <div className="composer-shell">
          <form className="composer" onSubmit={submitPrompt}>
            <textarea
              ref={composerInput}
              className="composer-input"
              value={composerDraft}
              onChange={(event) =>
                session && store.setComposerDraft(session.id, event.target.value)
              }
              onKeyDown={composerKeyDown}
              placeholder={isBusy ? "Queue a follow-up…" : "Ask the agent to work on something…"}
              aria-label="Prompt"
              rows={1}
            />
            {isBusy && session.activeTurnId && (
              <button
                type="button"
                className="composer-stop"
                aria-label="Stop the current turn"
                onClick={() => consumeUiAction(store.cancelTurn())}
                disabled={store.actionBusy}
              >
                <Icon name="stop" size={17} />
              </button>
            )}
            <button
              type="submit"
              className="composer-send"
              disabled={store.actionBusy || composerDraft.trim() === ""}
              aria-label={sendLabel}
            >
              <Icon name="send" size={19} />
            </button>
          </form>
          {isBusy && <p className="composer-note">Follow-ups start after this turn finishes.</p>}
        </div>
      )}
    </ThreadPrimitive.Root>
  );
}
