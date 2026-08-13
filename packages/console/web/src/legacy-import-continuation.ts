import type { TimelinePage } from "./types";

export interface LegacyImportContinuationOptions {
  readonly active: () => boolean;
  readonly wait: () => Promise<void>;
  readonly load: () => Promise<TimelinePage>;
  readonly apply: (page: TimelinePage) => void;
}

/**
 * Drain a server-side bounded legacy import without coupling progress to a
 * prompt, an SSE event, or another user action. Every pass remains bounded by
 * the session service; this loop only asks for the next pass while the same
 * browser selection is still active.
 */
export async function continueLegacyTimelineImport(
  options: LegacyImportContinuationOptions,
): Promise<void> {
  while (options.active()) {
    await options.wait();
    if (!options.active()) {
      return;
    }
    const page = await options.load();
    if (!options.active()) {
      return;
    }
    options.apply(page);
    if (page.legacyImportPending !== true) {
      return;
    }
  }
}
