import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { isQueueAdmissionOutcomeUnknown } from "../src/cli/queue/ipc.js";
import { QueueConnectionError } from "../src/errors.js";
import {
  AcpxIdempotencyConflictError,
  AcpxIdempotencyCorruptError,
  AcpxIdempotencyLedgerFullError,
  AcpxIdempotencyRetiredError,
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

test("legacy receipts rebuild recovery and session indexes before accepting a fresh key", async () => {
  await withTempHome("acpx-sessions-idempotency-", async () => {
    const recoveryScope = { agentId: "mock", cwd: "/legacy" };
    const scopeHash = idempotencyTestInternals.fingerprint(recoveryScope);
    const key = "legacy-first";
    const now = new Date().toISOString();
    const filePath = idempotencyTestInternals.mutationPath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      `${JSON.stringify({
        schema: "acpx.session_mutation.v1",
        idempotency_key: key,
        operation: "create_session",
        fingerprint: idempotencyTestInternals.fingerprint({
          ...recoveryScope,
          idempotencyKey: key,
        }),
        state: "started",
        created_at: now,
        updated_at: now,
        pid: process.pid,
        recovery_scope: scopeHash,
        recovery_result: { recordId: "legacy-record", phase: "created" },
      })}\n`,
      "utf8",
    );
    let runs = 0;
    const recovered = await runIdempotentMutation({
      operation: "create_session",
      idempotencyKey: "legacy-second",
      input: { ...recoveryScope, idempotencyKey: "legacy-second" },
      recoveryScope,
      recover: async () => ({ acpxRecordId: "legacy-record" }),
      run: async () => {
        runs += 1;
        return { acpxRecordId: "duplicate" };
      },
    });
    assert.equal(recovered.result.acpxRecordId, "legacy-record");
    assert.equal(recovered.replayed, true);
    assert.equal(runs, 0);
    await fs.access(idempotencyTestInternals.migrationMarkerPath());
    const sessionIndex = JSON.parse(
      await fs.readFile(idempotencyTestInternals.sessionIndexPath("legacy-record"), "utf8"),
    ) as { keys: string[] };
    assert.deepEqual(sessionIndex.keys.toSorted(), ["legacy-first", "legacy-second"]);
  });
});

test("a corrupt legacy receipt blocks migration and never runs a mutation", async () => {
  await withTempHome("acpx-sessions-idempotency-", async () => {
    const filePath = path.join(idempotencyTestInternals.baseDir(), `${"a".repeat(64)}.json`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{"schema":"corrupt"}\n', "utf8");
    let ran = false;
    await assert.rejects(
      async () =>
        await runIdempotentMutation({
          operation: "close_session",
          idempotencyKey: "after-corrupt-legacy",
          input: {},
          run: async () => {
            ran = true;
            return { closed: true };
          },
        }),
      /Invalid legacy idempotency receipt/u,
    );
    assert.equal(ran, false);
    await assert.rejects(
      async () => await fs.access(idempotencyTestInternals.migrationMarkerPath()),
    );
  });
});

test("scoped recovery reads its bounded index instead of scanning unrelated receipts", async () => {
  await withTempHome("acpx-sessions-idempotency-", async () => {
    const recoveryScope = { agentId: "mock", cwd: "/indexed" };
    await assert.rejects(
      async () =>
        await runIdempotentMutation({
          operation: "create_session",
          idempotencyKey: "indexed-first",
          input: { ...recoveryScope, idempotencyKey: "indexed-first" },
          recoveryScope,
          recover: async () => ({ acpxRecordId: "indexed-record" }),
          run: async (checkpoint) => {
            await checkpoint({ recordId: "indexed-record", phase: "created" });
            throw new Error("recover me");
          },
        }),
      /recover me/u,
    );

    // The old implementation scanned every *.json entry and would fail on an
    // unreadable/non-file entry. Indexed lookup must never touch this path.
    await fs.mkdir(path.join(idempotencyTestInternals.baseDir(), "unrelated.json"));
    const recovered = await runIdempotentMutation({
      operation: "create_session",
      idempotencyKey: "indexed-second",
      input: { ...recoveryScope, idempotencyKey: "indexed-second" },
      recoveryScope,
      recover: async () => ({ acpxRecordId: "indexed-record" }),
      run: async () => ({ acpxRecordId: "duplicate" }),
    });
    assert.equal(recovered.result.acpxRecordId, "indexed-record");
    assert.equal(recovered.replayed, true);
  });
});

test("a corrupt scoped recovery index fails closed", async () => {
  await withTempHome("acpx-sessions-idempotency-", async () => {
    const recoveryScope = { agentId: "mock", cwd: "/corrupt-index" };
    const scopeHash = idempotencyTestInternals.fingerprint(recoveryScope);
    const indexPath = idempotencyTestInternals.recoveryIndexPath(scopeHash);
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, '{"schema":"wrong"}\n', "utf8");
    let ran = false;
    await assert.rejects(
      async () =>
        await runIdempotentMutation({
          operation: "create_session",
          idempotencyKey: "corrupt-index-key",
          input: { ...recoveryScope, idempotencyKey: "corrupt-index-key" },
          recoveryScope,
          recover: async () => ({ acpxRecordId: "never" }),
          run: async () => {
            ran = true;
            return { acpxRecordId: "never" };
          },
        }),
      /Invalid idempotency index/u,
    );
    assert.equal(ran, false);
  });
});

test("terminal receipts compact to a bounded ledger and retired keys fail closed", async () => {
  await withTempHome("acpx-sessions-idempotency-", async () => {
    for (let index = 0; index < 520; index += 1) {
      await runIdempotentMutation({
        operation: "close_session",
        idempotencyKey: `bounded-${index}`,
        input: { index },
        run: async () => ({ closed: true }),
      });
    }
    const ledger = JSON.parse(
      await fs.readFile(idempotencyTestInternals.ledgerIndexPath(), "utf8"),
    ) as { entries: unknown[] };
    assert.equal(ledger.entries.length, 512);
    const rootEntries = await fs.readdir(idempotencyTestInternals.baseDir(), {
      withFileTypes: true,
    });
    assert.equal(
      rootEntries.filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name))
        .length,
      512,
    );

    let reran = false;
    await assert.rejects(
      async () =>
        await runIdempotentMutation({
          operation: "close_session",
          idempotencyKey: "bounded-0",
          input: { index: 0 },
          run: async () => {
            reran = true;
            return { closed: true };
          },
        }),
      AcpxIdempotencyRetiredError,
    );
    assert.equal(reran, false);
  });
});

test("exact retired keys do not reject neighbors and capacity expires instead of bricking", async () => {
  await withTempHome("acpx-sessions-idempotency-", async () => {
    const exactHash = idempotencyTestInternals.retiredKeyHash("retired-exact-key");
    const retiredPath = idempotencyTestInternals.retiredKeysPath(exactHash.slice(0, 2));
    await fs.mkdir(path.dirname(retiredPath), { recursive: true });
    const future = "2099-01-01T00:00:00.000Z";
    await fs.writeFile(
      retiredPath,
      `${JSON.stringify({
        schema: "acpx.session_mutation_retired.v1",
        prefix: exactHash.slice(0, 2),
        entries: [
          {
            key_hash: exactHash,
            expires_at: future,
          },
        ],
      })}\n`,
      "utf8",
    );
    let ran = false;
    const neighbor = await runIdempotentMutation({
      operation: "close_session",
      idempotencyKey: "retired-exact-key-neighbor",
      input: {},
      run: async () => {
        ran = true;
        return { closed: true };
      },
    });
    assert.equal(neighbor.replayed, false);
    assert.equal(ran, true);
    ran = false;
    await assert.rejects(
      async () =>
        await runIdempotentMutation({
          operation: "close_session",
          idempotencyKey: "retired-exact-key",
          input: {},
          run: async () => {
            ran = true;
            return { closed: true };
          },
        }),
      AcpxIdempotencyRetiredError,
    );
    assert.equal(ran, false);

    const capacityEntries = Array.from({ length: 1_024 }, (_, index) => ({
      key_hash: `00${index.toString(16).padStart(62, "0")}`,
      expires_at: future,
    }));
    await fs.writeFile(
      idempotencyTestInternals.retiredKeysPath("00"),
      `${JSON.stringify({
        schema: "acpx.session_mutation_retired.v1",
        prefix: "00",
        entries: capacityEntries,
      })}\n`,
      "utf8",
    );
    await fs.writeFile(
      idempotencyTestInternals.ledgerIndexPath(),
      `${JSON.stringify({
        schema: "acpx.session_mutation_ledger.v1",
        entries: Array.from({ length: 512 }, (_, index) => ({
          key: `terminal-${index}`,
          state: "succeeded",
          updated_at: "2026-01-01T00:00:00.000Z",
        })),
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      async () =>
        await runIdempotentMutation({
          operation: "close_session",
          idempotencyKey: "capacity-new-key",
          input: {},
          run: async () => {
            ran = true;
            return { closed: true };
          },
        }),
      AcpxIdempotencyLedgerFullError,
    );
    assert.equal(ran, false);

    await fs.writeFile(
      idempotencyTestInternals.retiredKeysPath("00"),
      `${JSON.stringify({
        schema: "acpx.session_mutation_retired.v1",
        prefix: "00",
        entries: capacityEntries.map((entry) => ({
          key_hash: entry.key_hash,
          expires_at: "2000-01-01T00:00:00.000Z",
        })),
      })}\n`,
      "utf8",
    );
    const afterExpiry = await runIdempotentMutation({
      operation: "close_session",
      idempotencyKey: "capacity-new-key",
      input: {},
      run: async () => {
        ran = true;
        return { closed: true };
      },
    });
    assert.equal(afterExpiry.replayed, false);
    assert.equal(ran, true);
  });
});

test("successful scoped recovery retires every equivalent started checkpoint", async () => {
  await withTempHome("acpx-sessions-idempotency-", async () => {
    const recoveryScope = { agentId: "mock", cwd: "/workspace", mode: "plan" };
    const checkpoint = { recordId: "record-equivalent", phase: "created" };
    const keys = ["equivalent-first", "equivalent-second"];
    let recoveries = 0;
    for (const key of keys) {
      await assert.rejects(
        async () =>
          await runIdempotentMutation({
            operation: "create_session",
            idempotencyKey: key,
            input: { ...recoveryScope, idempotencyKey: key },
            recoveryScope,
            recover: async (value) => {
              assert.deepEqual(value, checkpoint);
              recoveries += 1;
              throw new Error("recovery remains unavailable");
            },
            run: async (saveCheckpoint) => {
              await saveCheckpoint(checkpoint);
              throw new Error("initial side effect failed");
            },
          }),
        /(?:initial side effect failed|recovery remains unavailable)/u,
      );
    }

    const recovered = await runIdempotentMutation({
      operation: "create_session",
      idempotencyKey: "equivalent-third",
      input: { ...recoveryScope, idempotencyKey: "equivalent-third" },
      recoveryScope,
      recover: async (value) => {
        assert.deepEqual(value, checkpoint);
        recoveries += 1;
        return { id: checkpoint.recordId };
      },
      run: async () => ({ id: "duplicate" }),
    });
    assert.deepEqual(recovered.result, { id: checkpoint.recordId });

    for (const key of [...keys, "equivalent-third"]) {
      const stored = JSON.parse(
        await fs.readFile(idempotencyTestInternals.mutationPath(key), "utf8"),
      ) as { state?: string; result?: unknown };
      assert.equal(stored.state, "succeeded");
      assert.deepEqual(stored.result, { id: checkpoint.recordId });
    }
    assert.equal(recoveries, 2);
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
    await fs.writeFile(idempotencyTestInternals.migrationMarkerPath(), "v1\n", "utf8");
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
