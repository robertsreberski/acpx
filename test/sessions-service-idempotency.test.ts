import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { isQueueAdmissionOutcomeUnknown } from "../src/cli/queue/ipc.js";
import { QueueConnectionError } from "../src/errors.js";
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

test("a checkpointed mutation recovers its persisted side effect instead of repeating it", async () => {
  await withTempHome("acpx-sessions-idempotency-", async () => {
    let runs = 0;
    let recoveries = 0;
    const mutation = {
      operation: "create_session" as const,
      idempotencyKey: "checkpointed-create",
      input: { cwd: "/workspace" },
      recover: async (checkpoint: unknown) => {
        recoveries += 1;
        assert.deepEqual(checkpoint, { recordId: "record-1", phase: "created" });
        return { id: "record-1" };
      },
    };

    await assert.rejects(
      async () =>
        await runIdempotentMutation({
          ...mutation,
          run: async (checkpoint) => {
            runs += 1;
            await checkpoint({ recordId: "record-1", phase: "created" });
            throw new Error("projection failed after create");
          },
        }),
      /projection failed/,
    );

    const replay = await runIdempotentMutation({
      ...mutation,
      run: async () => {
        runs += 1;
        return { id: "unexpected" };
      },
    });
    assert.deepEqual(replay.result, { id: "record-1" });
    assert.equal(replay.replayed, true);
    assert.equal(runs, 1);
    assert.equal(recoveries, 1);
  });
});

test("a fresh idempotency key recovers a checkpointed mutation in the same scope", async () => {
  await withTempHome("acpx-sessions-idempotency-", async () => {
    let runs = 0;
    let recoveries = 0;
    const recoveryScope = { agentId: "mock", cwd: "/workspace", mode: "plan" };
    const recover = async (checkpoint: unknown) => {
      recoveries += 1;
      assert.deepEqual(checkpoint, { recordId: "record-scoped", phase: "created" });
      return { id: "record-scoped" };
    };

    await assert.rejects(
      async () =>
        await runIdempotentMutation({
          operation: "create_session",
          idempotencyKey: "scoped-create-first",
          input: { ...recoveryScope, idempotencyKey: "scoped-create-first" },
          recoveryScope,
          recover,
          run: async (checkpoint) => {
            runs += 1;
            await checkpoint({ recordId: "record-scoped", phase: "created" });
            throw new Error("mode failed after create");
          },
        }),
      /mode failed after create/u,
    );

    const freshKey = await runIdempotentMutation({
      operation: "create_session",
      idempotencyKey: "scoped-create-second",
      input: { ...recoveryScope, idempotencyKey: "scoped-create-second" },
      recoveryScope,
      recover,
      run: async () => {
        runs += 1;
        return { id: "duplicate" };
      },
    });
    const originalKey = await runIdempotentMutation({
      operation: "create_session",
      idempotencyKey: "scoped-create-first",
      input: { ...recoveryScope, idempotencyKey: "scoped-create-first" },
      recoveryScope,
      recover,
      run: async () => {
        runs += 1;
        return { id: "duplicate" };
      },
    });

    assert.deepEqual(freshKey.result, { id: "record-scoped" });
    assert.equal(freshKey.replayed, true);
    assert.deepEqual(originalKey.result, { id: "record-scoped" });
    assert.equal(originalKey.replayed, true);
    assert.equal(runs, 1);
    assert.equal(recoveries, 1);
  });
});

test("an ambiguous mutation keeps its recovery result instead of caching failure", async () => {
  await withTempHome("acpx-sessions-idempotency-", async () => {
    let runs = 0;
    const options = {
      operation: "enqueue_prompt" as const,
      idempotencyKey: "ambiguous-enqueue",
      input: { prompt: "hello" },
      recoveryResult: { turnId: "turn-1", admission: "unknown" as const },
      outcomeUnknown: (error: unknown) =>
        error instanceof Error && error.message === "disconnected after write",
    };
    await assert.rejects(
      async () =>
        await runIdempotentMutation<{ turnId: string; admission: "unknown" | "queued" }>({
          ...options,
          run: async () => {
            runs += 1;
            throw new Error("disconnected after write");
          },
        }),
      /disconnected after write/,
    );
    const replay = await runIdempotentMutation<{
      turnId: string;
      admission: "unknown" | "queued";
    }>({
      ...options,
      run: async () => {
        runs += 1;
        return { turnId: "turn-1", admission: "queued" as const };
      },
    });
    assert.deepEqual(replay.result, { turnId: "turn-1", admission: "unknown" });
    assert.equal(replay.replayed, true);
    assert.equal(runs, 1);
  });
});

test("a real acknowledged-owner disconnect replays unknown without submitting twice", async () => {
  await withTempHome("acpx-sessions-idempotency-", async () => {
    let submissions = 0;
    const options = {
      operation: "enqueue_prompt" as const,
      idempotencyKey: "owner-disconnected-after-accept",
      input: { acpxRecordId: "record-1", prompt: "hello" },
      recoveryResult: { turnId: "turn-stable", admission: "unknown" as const },
      outcomeUnknown: isQueueAdmissionOutcomeUnknown,
    };
    await assert.rejects(
      async () =>
        await runIdempotentMutation<{
          turnId: string;
          admission: "unknown" | "queued";
        }>({
          ...options,
          run: async () => {
            submissions += 1;
            throw new QueueConnectionError("owner accepted, then disconnected", {
              detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
              origin: "queue",
              retryable: true,
            });
          },
        }),
      /owner accepted, then disconnected/u,
    );

    const replay = await runIdempotentMutation<{
      turnId: string;
      admission: "unknown" | "queued";
    }>({
      ...options,
      run: async () => {
        submissions += 1;
        return { turnId: "turn-duplicate", admission: "queued" as const };
      },
    });
    assert.equal(submissions, 1);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, { turnId: "turn-stable", admission: "unknown" });
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
