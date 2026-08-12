import assert from "node:assert/strict";
import test from "node:test";
import { writeSseFrame } from "../src/sse.js";

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
