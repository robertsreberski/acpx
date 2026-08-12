import assert from "node:assert/strict";
import test from "node:test";
import { writeSseFrame, writeSseFrameOrDisconnect } from "../src/sse.js";

test("SSE frames use one write and preserve a false backpressure signal", () => {
  const chunks: string[] = [];
  const accepted = writeSseFrame(
    {
      write(chunk) {
        chunks.push(chunk);
        return false;
      },
    },
    { id: 7, event: { type: "timeline", acpxRecordId: "record-1" } },
  );
  assert.equal(accepted, false);
  assert.deepEqual(chunks, [
    'id: 7\nevent: timeline\ndata: {"type":"timeline","acpxRecordId":"record-1"}\n\n',
  ]);
});

test("SSE clients are synchronously disconnected when a frame reports backpressure", () => {
  let destroyed = 0;
  const accepted = writeSseFrameOrDisconnect(
    {
      write() {
        return false;
      },
      destroy() {
        destroyed += 1;
      },
    },
    { id: 8, event: { type: "sessions" } },
  );

  assert.equal(accepted, false);
  assert.equal(destroyed, 1);
});

test("SSE clients remain connected when a frame is accepted", () => {
  let destroyed = 0;
  const accepted = writeSseFrameOrDisconnect(
    {
      write() {
        return true;
      },
      destroy() {
        destroyed += 1;
      },
    },
    { id: 9, event: { type: "sessions" } },
  );

  assert.equal(accepted, true);
  assert.equal(destroyed, 0);
});
