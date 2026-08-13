import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

Object.assign(globalThis, { React });

test("a selected session awaiting detail offers retry and session-list recovery", async () => {
  const { SessionSelectionFallback } = await import("../src/components/SessionSelectionFallback");
  const markup = renderToStaticMarkup(
    createElement(SessionSelectionFallback, {
      onRetry: () => undefined,
      onOpenSessions: () => undefined,
    }),
  );

  assert.match(markup, /Opening session/u);
  assert.match(markup, />Retry<\/button>/u);
  assert.match(markup, />Sessions<\/button>/u);
});

test("the selection fallback keeps retry and session-list actions distinct", async () => {
  const { SessionSelectionFallback } = await import("../src/components/SessionSelectionFallback");
  const calls: string[] = [];
  const element = SessionSelectionFallback({
    onRetry: () => calls.push("retry"),
    onOpenSessions: () => calls.push("sessions"),
  });
  const children = element.props.children as readonly ReactElement[];
  const actions = children[3];
  const buttons = actions?.props.children as readonly ReactElement<{ onClick: () => void }>[];

  buttons[0]?.props.onClick();
  buttons[1]?.props.onClick();
  assert.deepEqual(calls, ["retry", "sessions"]);
});
