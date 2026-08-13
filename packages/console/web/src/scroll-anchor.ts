/**
 * Scroll anchoring for lazily paged history.
 *
 * Prepending an earlier page grows the scroll container upwards, which would
 * yank the reader to a different turn. CSS `overflow-anchor` would handle this
 * on Chrome, but the console's primary surface is an iPhone and Safari does not
 * implement it, so the offset is restored by hand: remember the distance from
 * the bottom before the prepend and reapply it after.
 */

export interface ScrollMetrics {
  readonly scrollHeight: number;
  readonly scrollTop: number;
}

export const distanceFromBottom = (metrics: ScrollMetrics): number =>
  metrics.scrollHeight - metrics.scrollTop;

export const anchoredScrollTop = (scrollHeight: number, distance: number): number =>
  Math.max(0, scrollHeight - distance);

const scrolls = (element: Element): boolean => {
  const overflowY = getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
};

/**
 * The nearest scrolling ancestor. Resolved from the DOM rather than a ref
 * because the thread viewport may render its own inner scroll container.
 */
export const scrollableAncestor = (node: Element | null): HTMLElement | null => {
  for (let current = node?.parentElement ?? null; current; current = current.parentElement) {
    if (scrolls(current)) {
      return current;
    }
  }
  return null;
};

/** Reapply an anchor without triggering the viewport's smooth-scroll animation. */
export const restoreScrollAnchor = (scroller: HTMLElement, distance: number): void => {
  const previousBehavior = scroller.style.scrollBehavior;
  scroller.style.scrollBehavior = "auto";
  scroller.scrollTop = anchoredScrollTop(scroller.scrollHeight, distance);
  scroller.style.scrollBehavior = previousBehavior;
};
