/**
 * Publish the on-screen keyboard's height as `--keyboard-inset`.
 *
 * The shell is sized from `height: 100%`, which on iOS measures the *layout*
 * viewport. That does not shrink when the keyboard opens, so the composer keeps
 * its place underneath it and the operator types blind. Only `visualViewport`
 * reports the covered region, and only as a side effect of its own geometry:
 * the keyboard is whatever part of the layout viewport the visual one no longer
 * reaches.
 *
 * Registration is best-effort and mirrors `registerInstallWorker`: a browser
 * without `visualViewport` — or a desktop, where the value is always zero — gets
 * the full console and a variable that stays at its `0px` fallback.
 */
const KEYBOARD_INSET_PROPERTY = "--keyboard-inset";

/**
 * Sub-pixel noise: iOS reports fractional viewport heights while scrolling, and
 * a bare `innerHeight - height` is rarely exactly zero with no keyboard open.
 * Anything smaller than this is not a keyboard.
 */
const MIN_MEANINGFUL_INSET_PX = 24;

/**
 * How much of the layout viewport the visual one no longer reaches.
 *
 * `offsetTop` matters: iOS scrolls the visual viewport within the layout one
 * when a focused field would otherwise sit behind the keyboard, and what is
 * covered is whatever remains below that offset.
 */
export const keyboardInsetFor = (measurement: {
  readonly layoutHeight: number;
  readonly viewportHeight: number;
  readonly viewportOffsetTop: number;
}): number => {
  const covered =
    measurement.layoutHeight - measurement.viewportHeight - measurement.viewportOffsetTop;
  return covered > MIN_MEANINGFUL_INSET_PX ? Math.round(covered) : 0;
};

export const registerKeyboardInset = (): (() => void) => {
  const viewport = window.visualViewport;
  if (!viewport) {
    return () => undefined;
  }

  const apply = (): void => {
    const inset = keyboardInsetFor({
      layoutHeight: window.innerHeight,
      viewportHeight: viewport.height,
      viewportOffsetTop: viewport.offsetTop,
    });
    document.documentElement.style.setProperty(KEYBOARD_INSET_PROPERTY, `${inset}px`);
  };

  apply();
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);

  return () => {
    viewport.removeEventListener("resize", apply);
    viewport.removeEventListener("scroll", apply);
    document.documentElement.style.removeProperty(KEYBOARD_INSET_PROPERTY);
  };
};
