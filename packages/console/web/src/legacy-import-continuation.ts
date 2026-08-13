import type { TimelinePage } from "./types";

export interface LegacyImportContinuationOptions {
  readonly active: () => boolean;
  readonly wait: (delayMs: number) => Promise<void>;
  readonly load: () => Promise<TimelinePage>;
  readonly apply: (page: TimelinePage) => void;
  /** Return false for a terminal error such as a deleted session. */
  readonly onError?: (error: unknown) => boolean;
}

const FIRST_PASS_DELAY_MS = 16;
const FIRST_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;

/**
 * Drain a server-side bounded legacy import without coupling progress to a
 * prompt, an SSE event, or another user action. Every pass remains bounded by
 * the session service; this loop only asks for the next pass while the same
 * browser selection is still active.
 */
export async function continueLegacyTimelineImport(
  options: LegacyImportContinuationOptions,
): Promise<void> {
  let delayMs = FIRST_PASS_DELAY_MS;
  while (options.active()) {
    await options.wait(delayMs);
    if (!options.active()) {
      return;
    }
    let page: TimelinePage;
    try {
      page = await options.load();
      delayMs = FIRST_PASS_DELAY_MS;
    } catch (error) {
      if (!options.active() || options.onError?.(error) === false) {
        return;
      }
      delayMs = Math.min(
        delayMs === FIRST_PASS_DELAY_MS ? FIRST_RETRY_DELAY_MS : delayMs * 2,
        MAX_RETRY_DELAY_MS,
      );
      continue;
    }
    if (!options.active()) {
      return;
    }
    options.apply(page);
    if (page.legacyImportPending !== true) {
      return;
    }
  }
}
