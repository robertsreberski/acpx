import type { SessionNotification, TurnCompletionResult } from "../../types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function hasContextCompactionMetadata(notification: SessionNotification): boolean {
  return asRecord(notification.update._meta)?.contextCompaction === true;
}

function compactionIdentity(notification: SessionNotification): string | undefined {
  const update = notification.update;
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return undefined;
  }
  return update.toolCallId.trim() || undefined;
}

function hasCodexFinalAnswerMetadata(notification: SessionNotification): boolean {
  const codex = asRecord(asRecord(notification.update._meta)?.codex);
  return codex?.phase === "final_answer";
}

function hasNonEmptyText(notification: SessionNotification): boolean {
  const update = notification.update;
  return (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content.type === "text" &&
    update.content.text.trim().length > 0
  );
}

export function completionForStopReason(
  stopReason: TurnCompletionResult["stopReason"],
): TurnCompletionResult {
  return stopReason === "cancelled"
    ? { status: "cancelled", stopReason }
    : { status: "completed", stopReason };
}

/** Tracks Codex completion evidence for exactly one live prompt attempt. */
export class TurnCompletionTracker {
  private active = false;
  private compactionGeneration = 0;
  private finalAnswerGeneration = 0;
  private readonly observedCompactionIds = new Set<string>();

  beginAttempt(): void {
    this.active = true;
    this.compactionGeneration = 0;
    this.finalAnswerGeneration = 0;
    this.observedCompactionIds.clear();
  }

  abandonAttempt(): void {
    this.active = false;
  }

  observe(notification: SessionNotification): void {
    if (!this.active) {
      return;
    }

    if (this.observeCompaction(notification)) {
      return;
    }

    if (
      this.compactionGeneration > 0 &&
      // The completion contract is intentionally exact: the nonempty text and
      // final_answer metadata must occur on the same agent_message_chunk.
      // Combining evidence across notifications would invent protocol state.
      hasCodexFinalAnswerMetadata(notification) &&
      hasNonEmptyText(notification)
    ) {
      this.finalAnswerGeneration = this.compactionGeneration;
    }
  }

  private observeCompaction(notification: SessionNotification): boolean {
    if (!hasContextCompactionMetadata(notification)) {
      return false;
    }
    const identity = compactionIdentity(notification);
    if (identity && this.observedCompactionIds.has(identity)) {
      return true;
    }
    if (identity) {
      this.observedCompactionIds.add(identity);
    }
    this.compactionGeneration += 1;
    this.finalAnswerGeneration = 0;
    return true;
  }

  hasUnansweredCompaction(): boolean {
    return (
      this.active &&
      this.compactionGeneration > 0 &&
      this.finalAnswerGeneration !== this.compactionGeneration
    );
  }

  finish(stopReason: TurnCompletionResult["stopReason"]): TurnCompletionResult {
    const incomplete = stopReason !== "cancelled" && this.hasUnansweredCompaction();
    this.active = false;
    return incomplete
      ? { status: "incomplete", stopReason, reason: "context_compaction" }
      : completionForStopReason(stopReason);
  }
}
