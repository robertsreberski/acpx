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
  readonly offsetParent?: unknown;
  checkVisibility?: () => boolean;
  focus(): void;
}

/**
 * A control the stylesheet has hidden at this viewport cannot take focus, so
 * offering it as the layer's first or last stop strands the user: focusing it is
 * a no-op and the opener is already inert. Anything that cannot report its
 * visibility — a test double, or a host without `checkVisibility` — is treated
 * as visible rather than silently dropped.
 */
const isFocusable = (target: FocusTarget): boolean => {
  if (target.isConnected === false) {
    return false;
  }
  if (typeof target.checkVisibility === "function") {
    return target.checkVisibility();
  }
  return target.offsetParent !== null;
};

interface TabKeyEvent extends EscapeKeyEvent {
  readonly shiftKey?: boolean;
}

interface FocusContainer {
  contains(target: unknown): boolean;
  querySelectorAll<T extends FocusTarget>(selector: string): ArrayLike<T>;
}

export const layerOwnsTarget = (layer: FocusContainer, target: unknown): boolean =>
  layer.contains(target);

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

export const trapLayerTab = (
  event: TabKeyEvent,
  layer: FocusContainer,
  activeElement: unknown,
): boolean => {
  if (event.key !== "Tab" || event.defaultPrevented) {
    return false;
  }
  const targets = Array.from(layer.querySelectorAll<FocusTarget>(FOCUSABLE_SELECTOR)).filter(
    (target) => isFocusable(target),
  );
  const first = targets[0];
  const last = targets.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return true;
  }
  if (
    event.shiftKey
      ? activeElement === first || !layerOwnsTarget(layer, activeElement)
      : activeElement === last
  ) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return true;
  }
  return false;
};

const layerStack: symbol[] = [];

const inertOutsideLayer = (layer: HTMLElement): (() => void) => {
  const changed: Array<{ element: HTMLElement; inert: boolean; ariaHidden: string | null }> = [];
  let branch: HTMLElement | null = layer;
  while (branch?.parentElement && branch.parentElement.id !== "root") {
    for (const sibling of branch.parentElement.children) {
      if (sibling !== branch && sibling instanceof HTMLElement) {
        changed.push({
          element: sibling,
          inert: sibling.hasAttribute("inert"),
          ariaHidden: sibling.getAttribute("aria-hidden"),
        });
        sibling.setAttribute("inert", "");
        sibling.setAttribute("aria-hidden", "true");
      }
    }
    branch = branch.parentElement;
  }
  return () => {
    for (const { element, inert, ariaHidden } of changed) {
      if (!inert) {
        element.removeAttribute("inert");
      }
      if (ariaHidden === null) {
        element.removeAttribute("aria-hidden");
      } else {
        element.setAttribute("aria-hidden", ariaHidden);
      }
    }
  };
};

/** Escape-dismiss a transient layer and restore focus to the control that opened it. */
export const useDismissibleLayer = (
  open: boolean,
  onClose: () => void,
  layerRef?: RefObject<HTMLElement | null>,
): void => {
  const onCloseRef = useRef(onClose);
  const tokenRef = useRef(Symbol("dismissible-layer"));
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer = layerRef?.current ?? null;
    const token = tokenRef.current;
    layerStack.push(token);
    const restoreInert = layer ? inertOutsideLayer(layer) : () => undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (layerStack.at(-1) !== token) {
        return;
      }
      if (dismissOnEscape(event, () => onCloseRef.current())) {
        return;
      }
      if (layer) {
        trapLayerTab(event, layer, document.activeElement);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    queueMicrotask(() => {
      if (layer && !layer.contains(document.activeElement)) {
        Array.from(layer.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
          .find((target) => isFocusable(target))
          ?.focus();
      }
    });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const index = layerStack.lastIndexOf(token);
      if (index >= 0) {
        layerStack.splice(index, 1);
      }
      restoreInert();
      queueMicrotask(() => {
        const active = document.activeElement;
        if (!active || active === document.body || !active.isConnected || layer?.contains(active)) {
          restoreLayerFocus(opener);
        }
      });
    };
  }, [layerRef, open]);
};
