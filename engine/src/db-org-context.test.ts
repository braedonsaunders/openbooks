import { strict as assert } from "node:assert";
import { test } from "node:test";
import { orgContext, withBypassContext, withOrgContext } from "./db.ts";

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
  await withOrgContext("11111111-1111-1111-1111-111111111111", () =>
    lazyWork(observed) as Promise<string>);
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
    await withOrgContext("22222222-2222-2222-2222-222222222222", () =>
      lazyWork(inner) as Promise<string>);
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
