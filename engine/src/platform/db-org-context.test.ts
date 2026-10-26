import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  db,
  inDbTransaction,
  inExecutorTransaction,
  onTransactionRollback,
  orgContext,
  pinnedTransactionExecutor,
  pool,
  registerRequestOrgResolver,
  withBypassContext,
  withOrgContext,
  withOrgTransaction,
} from "./db.ts";

/**
 * Regression guard for the worst failure mode this database layer has:
 * a tenant scope that is entered but not HELD, so the pooled-query wrapper
 * reads no context, applies the deny-by-default RLS GUCs, and hands back zero
 * rows with no error to a caller that believes it holds bypass.
 *
 * That is not hypothetical. `withBypassContext` and `withOrgContext` used
 * `orgContext.run(ctx, fn)` directly. A drizzle query builder is a LAZY
 * THENABLE — it touches the pool only when something awaits it — so the
 * idiomatic
 *
 *     withBypassContext(() => db.execute(sql`select ... from orgs`))
 *
 * returned the un-started thenable out of the scope, and the caller's `await`
 * ran it outside. Every org-spanning maintenance script written that way read
 * an empty database and reported success. The tie-out this was found by
 * "passed" against zero employees.
 *
 * These tests use the same lazy-thenable shape drizzle does, so they fail on
 * the broken implementation and need no database.
 */

/** Records the ambient tenant context at the moment work actually begins. */
function lazyWork(observed: (unknown | null)[]): PromiseLike<string> {
  let started = false;
  return {
    then<R>(onFulfilled?: ((value: string) => R | PromiseLike<R>) | null) {
      // A drizzle builder reaches the pool here, not at construction.
      started = true;
      observed.push(orgContext.getStore() ?? null);
      return Promise.resolve("done").then(onFulfilled) as Promise<R>;
    },
    get hasStarted() {
      return started;
    },
  } as PromiseLike<string>;
}

test("withBypassContext holds the scope until a lazy query actually runs", async () => {
  const observed: (unknown | null)[] = [];
  const result = await withBypassContext(() => lazyWork(observed) as Promise<string>);
  assert.equal(result, "done");
  assert.equal(observed.length, 1);
  assert.deepEqual(
    observed[0],
    { orgId: null, bypass: true },
    "the lazy query executed outside the bypass scope — it would silently read zero rows",
  );
});

test("withOrgContext holds the scope until a lazy query actually runs", async () => {
  const observed: (unknown | null)[] = [];
  await withOrgContext(
    "11111111-1111-1111-1111-111111111111",
    () => lazyWork(observed) as Promise<string>,
  );
  assert.deepEqual(
    observed[0],
    { orgId: "11111111-1111-1111-1111-111111111111", bypass: false },
    "the lazy query executed outside the tenant scope — it would silently read zero rows",
  );
});

test("both callback shapes see identical context — no silent two-tier contract", async () => {
  // A plain async callback was never affected (its body starts synchronously),
  // which is exactly why the defect survived: half the call sites worked.
  const eager: (unknown | null)[] = [];
  const lazy: (unknown | null)[] = [];
  await withBypassContext(async () => {
    eager.push(orgContext.getStore() ?? null);
    await Promise.resolve();
    eager.push(orgContext.getStore() ?? null);
  });
  await withBypassContext(() => lazyWork(lazy) as Promise<string>);
  assert.deepEqual(lazy[0], eager[0]);
  assert.deepEqual(lazy[0], eager[1]);
});

test("a nested lazy query still sees the innermost scope", async () => {
  const outer: (unknown | null)[] = [];
  const inner: (unknown | null)[] = [];
  await withBypassContext(async () => {
    await withOrgContext(
      "22222222-2222-2222-2222-222222222222",
      () => lazyWork(inner) as Promise<string>,
    );
    await (lazyWork(outer) as Promise<string>);
  });
  assert.deepEqual(inner[0], { orgId: "22222222-2222-2222-2222-222222222222", bypass: false });
  assert.deepEqual(outer[0], { orgId: null, bypass: true });
});

test("the scope is released after the callback settles, including on failure", async () => {
  await assert.rejects(
    withBypassContext(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(orgContext.getStore(), undefined);
});

test("a nested isolation request inside an ambient bypass transaction refuses by name instead of dropping", async () => {
  // The pinned bypass transaction is already running: SET TRANSACTION
  // cannot apply, so the request must fail loudly. Needs no database —
  // the refusal fires before any connection is touched.
  await assert.rejects(
    () =>
      orgContext.run({ orgId: null, bypass: true, txDb: {} as never }, () =>
        withOrgTransaction(
          "11111111-1111-1111-1111-111111111111",
          () => Promise.resolve("unreached"),
          { isolationLevel: "REPEATABLE READ" },
        ),
      ),
    /cannot change isolation inside an active bypass transaction/,
  );
});

test("a nested db.transaction verifies the enclosing isolation and access mode instead of dropping them", async () => {
  const ambient = (isolation: string, readOnly: string) => ({
    execute: async (_query: unknown, mode?: string) =>
      Promise.resolve({ rows: [{ isolation, read_only: readOnly }] }).then(
        <T extends { rows: unknown }>(result: T) => (mode === "objects" ? result.rows : result),
      ),
  });
  const nested = (txDb: object, config: Parameters<typeof db.transaction>[1]) =>
    orgContext.run(
      { orgId: "11111111-1111-1111-1111-111111111111", bypass: false, txDb: txDb as never },
      () => db.transaction(async () => "joined", config),
    );
  await assert.rejects(
    () => nested(ambient("read committed", "off"), { isolationLevel: "repeatable read" }),
    /cannot raise isolation to repeatable read inside an active transaction running at read committed/,
  );
  await assert.rejects(
    () => nested(ambient("serializable", "off"), { accessMode: "read only" }),
    /cannot make an active read-write transaction read only/,
  );
  assert.equal(
    await nested(ambient("serializable", "on"), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    }),
    "joined",
  );
  assert.equal(await nested(ambient("read committed", "off"), undefined), "joined");
});

/**
 * A stand-in pooled client for transaction tests: it records each checkout
 * and answers the begin/commit/rollback statements a database transaction
 * issues, so pinning behaviour is observable without a database.
 */
async function withFakePoolClient<T>(
  fn: (stats: { connects: number; queries: string[]; releases: unknown[] }) => Promise<T>,
  failures: Readonly<Record<string, Error>> = {},
): Promise<T> {
  const stats = { connects: 0, queries: [] as string[], releases: [] as unknown[] };
  const fakeClient = Object.assign(new EventEmitter(), {
    query: async (input: unknown) => {
      const text =
        typeof input === "string" ? input : ((input as { text?: string } | null)?.text ?? "");
      stats.queries.push(text);
      const failure = failures[text.trim().toLowerCase()];
      if (failure) throw failure;
      return { rows: [], fields: [], command: "", rowCount: 0, oid: 0 };
    },
    release: (error?: unknown) => {
      stats.releases.push(error);
    },
  });
  const originalConnect = pool.connect;
  (pool as unknown as { connect: unknown }).connect = async () => {
    stats.connects += 1;
    return fakeClient;
  };
  try {
    return await fn(stats);
  } finally {
    (pool as unknown as { connect: unknown }).connect = originalConnect;
  }
}

test("db.transaction without an org boundary pins txDb and nested units join it", async () => {
  await withFakePoolClient(async (stats) => {
    await withOrgContext("33333333-3333-3333-3333-333333333333", async () => {
      assert.equal(pinnedTransactionExecutor(), undefined);
      await db.transaction(async (tx) => {
        assert.equal(
          orgContext.getStore()?.txDb as unknown,
          tx as unknown,
          "the opened transaction is not pinned — nested db work would leave it",
        );
        assert.equal(orgContext.getStore()?.orgId, "33333333-3333-3333-3333-333333333333");
        assert.equal(orgContext.getStore()?.bypass, false);
        assert.equal(pinnedTransactionExecutor() as unknown, tx as unknown);

        await db.transaction(async (nestedTx) => {
          assert.equal(
            nestedTx as unknown,
            tx as unknown,
            "nested db.transaction opened a second unit",
          );
        });
        await inDbTransaction(async (joinedTx) => {
          assert.equal(joinedTx as unknown, tx as unknown, "inDbTransaction opened a second unit");
        });
        await inExecutorTransaction(db, async (joinedTx) => {
          assert.equal(joinedTx as unknown, db as unknown);
        });
      });
      assert.equal(pinnedTransactionExecutor(), undefined, "the pin outlived the transaction");
    });
    assert.equal(stats.connects, 1, "nested units must share the one checked-out connection");
  });
});

test("db.transaction under a request org resolver pins txDb with the resolved scope", async () => {
  await withFakePoolClient(async (stats) => {
    registerRequestOrgResolver(() => ({
      orgId: "44444444-4444-4444-4444-444444444444",
      bypass: false,
    }));
    try {
      assert.equal(orgContext.getStore(), undefined);
      await db.transaction(async (tx) => {
        assert.equal(orgContext.getStore()?.txDb as unknown, tx as unknown);
        assert.equal(orgContext.getStore()?.orgId, "44444444-4444-4444-4444-444444444444");
        await inDbTransaction(async (joinedTx) => {
          assert.equal(joinedTx as unknown, tx as unknown);
        });
      });
      assert.equal(orgContext.getStore(), undefined);
    } finally {
      registerRequestOrgResolver(() => undefined);
    }
    assert.equal(stats.connects, 1);
  });
});

test("inExecutorTransaction on the pooled db pins the opened transaction", async () => {
  await withFakePoolClient(async (stats) => {
    await withOrgContext("55555555-5555-5555-5555-555555555555", async () => {
      await inExecutorTransaction(db, async (tx) => {
        assert.equal(pinnedTransactionExecutor() as unknown, tx as unknown);
        await inDbTransaction(async (joinedTx) => {
          assert.equal(joinedTx as unknown, tx as unknown);
        });
      });
      assert.equal(pinnedTransactionExecutor(), undefined);
    });
    assert.equal(stats.connects, 1);
  });
});

test("rollback effects run when db.transaction rejects and not when it resolves", async () => {
  await withFakePoolClient(async () => {
    const compensated: string[] = [];
    await withOrgContext("66666666-6666-6666-6666-666666666666", async () => {
      await db.transaction(async () => {
        onTransactionRollback(async () => {
          compensated.push("committed-unit");
        });
      });
      assert.equal(compensated.length, 0, "a resolved transaction must not compensate");

      await assert.rejects(
        db.transaction(async () => {
          onTransactionRollback(async () => {
            compensated.push("rolled-back-unit");
          });
          throw new Error("unit failed");
        }),
        /unit failed/,
      );
      assert.deepEqual(compensated, ["rolled-back-unit"]);
      assert.equal(
        pinnedTransactionExecutor(),
        undefined,
        "the pin outlived the failed transaction",
      );
    });
  });
});

test("a refused transaction start releases its connection and never runs business work", async () => {
  const failure = new Error("transaction start refused");
  let called = false;
  await withFakePoolClient(
    async (stats) => {
      await assert.rejects(
        db.transaction(async () => {
          called = true;
        }),
        (error: unknown) => error instanceof Error && error.cause === failure,
      );
      assert.equal(called, false);
      assert.equal(stats.releases.length, 1);
      assert.equal(
        stats.queries.filter((query) => query.trim().toLowerCase() === "rollback").length,
        0,
      );
    },
    { begin: failure },
  );
});

test("a rollback failure preserves the business refusal and discards the damaged connection", async () => {
  const refusal = new Error("business operation refused");
  const rollbackFailure = new Error("rollback failed");
  await withFakePoolClient(
    async (stats) => {
      await assert.rejects(
        db.transaction(async () => {
          throw refusal;
        }),
        (error: unknown) => error === refusal,
      );
      assert.equal(stats.releases.length, 1);
      const releasedWith = stats.releases[0];
      assert.ok(releasedWith instanceof Error);
      assert.equal(releasedWith.cause, rollbackFailure);
    },
    { rollback: rollbackFailure },
  );
});
