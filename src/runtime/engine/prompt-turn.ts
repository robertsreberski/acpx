import { TimeoutError, withTimeout } from "../../async-control.js";
import {
  hasAgentReplyAfterPrompt,
  recordPromptResponseUsage,
} from "../../session/conversation-model.js";
import type { PromptInput, SessionConversation, TurnCompletionResult } from "../../types.js";
import { completionForStopReason, TurnCompletionTracker } from "./turn-completion.js";

const SESSION_REPLY_IDLE_MS = 1_000;
const SESSION_REPLY_DRAIN_TIMEOUT_MS = 5_000;

type PromptTurnClient = {
  prompt: (
    sessionId: string,
    prompt: PromptInput | string,
  ) => Promise<{ stopReason: TurnCompletionResult["stopReason"]; usage?: unknown }>;
  waitForSessionUpdatesIdle?: (options?: { idleMs?: number; timeoutMs?: number }) => Promise<void>;
};

export type PromptTurnResult = TurnCompletionResult & { source: "rpc" | "session" };

type RunPromptTurnParams = {
  client: PromptTurnClient;
  sessionId: string;
  prompt: PromptInput | string;
  timeoutMs?: number;
  conversation?: SessionConversation;
  promptMessageId?: string;
  onPromptStarted?: () => Promise<void> | void;
  completionTracker?: TurnCompletionTracker;
  initialDrainIdleMs?: number;
};

function completionResult(
  tracker: TurnCompletionTracker | undefined,
  stopReason: TurnCompletionResult["stopReason"],
): TurnCompletionResult {
  return tracker?.finish(stopReason) ?? completionForStopReason(stopReason);
}

async function drainSessionUpdates(client: PromptTurnClient, idleMs: number): Promise<void> {
  await client
    .waitForSessionUpdatesIdle?.({
      idleMs,
      timeoutMs: SESSION_REPLY_DRAIN_TIMEOUT_MS,
    })
    .catch(() => {
      // Best effort. Preserve the prompt response or error when late-update draining times out.
    });
}

async function drainPromptResponse(params: RunPromptTurnParams): Promise<void> {
  const initialIdleMs = params.initialDrainIdleMs ?? SESSION_REPLY_IDLE_MS;
  if (
    initialIdleMs < SESSION_REPLY_IDLE_MS &&
    params.completionTracker?.hasUnansweredCompaction()
  ) {
    await drainSessionUpdates(params.client, SESSION_REPLY_IDLE_MS);
    return;
  }
  await drainSessionUpdates(params.client, initialIdleMs);
  if (
    initialIdleMs < SESSION_REPLY_IDLE_MS &&
    params.completionTracker?.hasUnansweredCompaction()
  ) {
    // Ordinary one-shot turns use a short initial drain, but once compaction
    // appears the full settle window is required for a later final answer.
    await drainSessionUpdates(params.client, SESSION_REPLY_IDLE_MS);
  }
}

async function runPromptRpc(params: RunPromptTurnParams): Promise<PromptTurnResult> {
  const promptPromise = params.client.prompt(params.sessionId, params.prompt);
  await params.onPromptStarted?.();
  const response = await withTimeout(promptPromise, params.timeoutMs);
  // The compaction marker itself can arrive after the prompt response. Drain
  // before classifying, extending a short one-shot drain when compaction needs
  // more time to produce its final answer.
  await drainPromptResponse(params);
  if (params.conversation) {
    recordPromptResponseUsage(params.conversation, response.usage, params.promptMessageId);
  }
  return {
    ...completionResult(params.completionTracker, response.stopReason),
    source: "rpc",
  };
}

function canSalvageTimedOutReply(params: RunPromptTurnParams): boolean {
  return Boolean(
    params.conversation &&
    params.promptMessageId &&
    hasAgentReplyAfterPrompt(params.conversation, params.promptMessageId),
  );
}

function canInspectTimedOutReply(
  params: RunPromptTurnParams,
  error: unknown,
): error is TimeoutError {
  return error instanceof TimeoutError && Boolean(params.conversation && params.promptMessageId);
}

async function recoverPromptError(
  params: RunPromptTurnParams,
  error: unknown,
): Promise<PromptTurnResult> {
  if (!canInspectTimedOutReply(params, error)) {
    // One-shot callers keep no durable conversation that could prove a late
    // assistant reply. Respect timeouts without adding a futile drain, and
    // preserve non-timeout failures unchanged.
    params.completionTracker?.abandonAttempt();
    throw error;
  }
  await drainSessionUpdates(params.client, SESSION_REPLY_IDLE_MS);
  if (params.completionTracker?.hasUnansweredCompaction()) {
    params.completionTracker.abandonAttempt();
    throw error;
  }
  if (canSalvageTimedOutReply(params)) {
    return {
      ...completionResult(params.completionTracker, "end_turn"),
      source: "session",
    };
  }
  params.completionTracker?.abandonAttempt();
  throw error;
}

export async function runPromptTurn(params: RunPromptTurnParams): Promise<PromptTurnResult> {
  params.completionTracker?.beginAttempt();
  try {
    return await runPromptRpc(params);
  } catch (error) {
    return await recoverPromptError(params, error);
  }
}
