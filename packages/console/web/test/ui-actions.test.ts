import test from "node:test";
import { consumeUiAction } from "../src/ui-actions";

test("UI actions consume a rejection after the store has already surfaced it", async () => {
  consumeUiAction(Promise.reject(new Error("already surfaced")));
  await new Promise<void>((resolve) => setImmediate(resolve));
});
