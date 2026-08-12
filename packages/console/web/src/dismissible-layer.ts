import { useEffect, type RefObject, useRef } from "react";

interface EscapeKeyEvent {
  readonly key: string;
  readonly isComposing?: boolean;
  readonly defaultPrevented?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

interface FocusTarget {
  readonly isConnected?: boolean;
  focus(): void;
}

export const dismissOnEscape = (event: EscapeKeyEvent, dismiss: () => void): boolean => {
  if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  dismiss();
  return true;
};

export const restoreLayerFocus = (target: FocusTarget | null): boolean => {
  if (!target || target.isConnected === false) {
    return false;
  }
  target.focus();
  return true;
};

const FOCUSABLE_SELECTOR = [
  "[autofocus]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Escape-dismiss a transient layer and restore focus to the control that opened it. */
export const useDismissibleLayer = (
  open: boolean,
  onClose: () => void,
  layerRef?: RefObject<HTMLElement | null>,
): void => {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      return;
    }
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer = layerRef?.current ?? null;
    const onKeyDown = (event: KeyboardEvent) => {
      dismissOnEscape(event, () => onCloseRef.current());
    };
    document.addEventListener("keydown", onKeyDown);
    queueMicrotask(() => {
      if (layer && !layer.contains(document.activeElement)) {
        layer.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
      }
    });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      queueMicrotask(() => {
        const active = document.activeElement;
        if (!active || active === document.body || !active.isConnected || layer?.contains(active)) {
          restoreLayerFocus(opener);
        }
      });
    };
  }, [layerRef, open]);
};
