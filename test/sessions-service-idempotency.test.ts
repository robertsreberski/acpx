import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  AcpxIdempotencyConflictError,
  AcpxIdempotencyCorruptError,
  idempotencyTestInternals,
  runIdempotentMutation,
} from "../src/sessions-service/idempotency.js";
import { withTempHome } from "./runtime-test-helpers.js";

test("idempotent mutations execute once and reject key reuse with different input", async () => {
  await withTempHome("acpx-sessions-idempotency-", async () => {
    let calls = 0;
    const first = await runIdempotentMutation({
      operation: "create_session",
      idempotencyKey: "create-one",
      input: { cwd: "/workspace", name: undefined },
      run: async () => ({ id: ++calls }),
    });
    const replay = await runIdempotentMutation({
      operation: "create_session",
      idempotencyKey: "create-one",
      input: { name: undefined, cwd: "/workspace" },
      run: async () => ({ id: ++calls }),
    });

    assert.deepEqual(first, {
      operation: "create_session",
      idempotencyKey: "create-one",
      replayed: false,
      result: { id: 1 },
    });
    assert.deepEqual(replay, { ...first, replayed: true });
    assert.equal(calls, 1);

    await assert.rejects(
      async () =>
        await runIdempotentMutation({
          operation: "create_session",
          idempotencyKey: "create-one",
          input: { cwd: "/other" },
          run: async () => ({ id: ++calls }),
        }),
      AcpxIdempotencyConflictError,
    );
    assert.equal(calls, 1);
  });
});

test("a schema-invalid mutation record fails closed instead of repeating the mutation", async () => {
  await withTempHome("acpx-sessions-idempotency-", async () => {
    const key = "corrupt-record";
    const recordPath = idempotencyTestInternals.mutationPath(key);
    await fs.mkdir(path.dirname(recordPath), { recursive: true });
    await fs.writeFile(
      recordPath,
      `${JSON.stringify({ schema: "acpx.session_mutation.v999", idempotency_key: key })}\n`,
      "utf8",
    );
    let ran = false;

    await assert.rejects(
      async () =>
        await runIdempotentMutation({
          operation: "close_session",
          idempotencyKey: key,
          input: { acpxRecordId: "session-1" },
          run: async () => {
            ran = true;
            return { closed: true };
          },
        }),
      AcpxIdempotencyCorruptError,
    );
    assert.equal(ran, false);
  });
});

test("an old lock owned by a live process stays authoritative", async () => {
  await withTempHome("acpx-sessions-idempotency-", async () => {
    const lockPath = idempotencyTestInternals.lockPath("live-lock");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, created_at: "2000-01-01T00:00:00.000Z" })}\n`,
      "utf8",
    );

    assert.equal(await idempotencyTestInternals.removeStaleLock(lockPath), false);
    assert.equal(await fs.readFile(lockPath, "utf8").then(() => true), true);
  });
});

test("the mutation ledger directory and files are private", async () => {
  await withTempHome("acpx-sessions-idempotency-", async () => {
    await runIdempotentMutation({
      operation: "close_session",
      idempotencyKey: "private-ledger",
      input: { acpxRecordId: "session-1" },
      run: async () => ({ closed: true }),
    });

    const directoryMode = (await fs.stat(idempotencyTestInternals.baseDir())).mode & 0o777;
    const fileMode =
      (await fs.stat(idempotencyTestInternals.mutationPath("private-ledger"))).mode & 0o777;
    assert.equal(directoryMode, 0o700);
    assert.equal(fileMode, 0o600);
  });
});
