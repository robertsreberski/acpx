import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

Object.assign(globalThis, { React });

test("the mobile Sessions control directly targets the session drawer", async () => {
  const { MobileSessionListButton } = await import("../src/components/MobileSessionListButton");
  const markup = renderToStaticMarkup(
    createElement(MobileSessionListButton, { open: false, onOpen: () => undefined }),
  );

  assert.match(markup, /aria-label="Open sessions"/u);
  assert.match(markup, /aria-controls="session-sidebar"/u);
  assert.match(markup, /aria-haspopup="dialog"/u);
  assert.match(markup, /aria-expanded="false"/u);
  assert.match(markup, /> Sessions<\/button>/u);
});

test("the mobile Sessions control invokes only its drawer-open action", async () => {
  const { MobileSessionListButton } = await import("../src/components/MobileSessionListButton");
  let openCount = 0;
  const element = MobileSessionListButton({
    open: false,
    onOpen: () => {
      openCount += 1;
    },
  });

  element.props.onClick();
  assert.equal(openCount, 1);
});
