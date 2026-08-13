export const LIVE_INVALIDATION_EVENT_NAMES = [
  "sessions",
  "session",
  "timeline",
  "pending",
  "reset",
  "message",
] as const;

interface LiveEventTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export const listenForLiveInvalidations = (
  target: LiveEventTarget,
  listener: EventListener,
): (() => void) => {
  for (const eventName of LIVE_INVALIDATION_EVENT_NAMES) {
    target.addEventListener(eventName, listener);
  }
  return () => {
    for (const eventName of LIVE_INVALIDATION_EVENT_NAMES) {
      target.removeEventListener(eventName, listener);
    }
  };
};
