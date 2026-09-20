import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { db } from "../platform/db.ts";
import { type Doc, PostingError } from "./posting-contracts.ts";
import { resolvePostingPeriod, assertPayRunConsolidatedRateCoverage } from "./posting-period.ts";

function scripted(rows: unknown[][]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const runner = { execute: async (query: SQL) => {
    assert.ok(calls.length < rows.length, "unexpected database query");
    const next = rows[calls.length]!;
    calls.push(new PgDialect().sqlToQuery(query));
    return { rows: next };
  } } as unknown as Pick<typeof db, "execute">;
  return { runner, calls, done: () => assert.equal(calls.length, rows.length, "all expected database reads must occur") };
}
const document = (postingPeriodId: string | null): Doc => ({ orgId: "org-a", postingPeriodId }) as Doc;
const args = { orgId: "org-a", docCurrency: "CAD", docSubsidiaryId: "child", postingDate: "2026-09-20" };
const root = [{ id: "root", base_currency: "USD" }];
const chain = [
  { id: "child", parent_id: "middle", base_currency: "CAD" },
  { id: "middle", parent_id: "root", base_currency: "EUR" },
  { id: "root", parent_id: null, base_currency: "USD" },
];
const period = [{ id: "period-a", ends_on: "2026-09-30" }];

test("explicit posting period is scoped to the organization; date fallback excludes adjustment periods", async () => {
  const explicit = scripted([[{ id: "override" }]]);
  assert.deepEqual(await resolvePostingPeriod(explicit.runner, document("override"), args.postingDate), { id: "override" });
  assert.deepEqual(explicit.calls[0]!.params, ["override", "org-a"]);
  explicit.done();
  const dated = scripted([[{ id: "regular" }]]);
  assert.deepEqual(await resolvePostingPeriod(dated.runner, document(null), args.postingDate), { id: "regular" });
  assert.deepEqual(dated.calls[0]!.params, ["org-a", args.postingDate, args.postingDate]);
  assert.match(dated.calls[0]!.sql, /is_adjustment = false/);
  dated.done();
});

test("missing override and uncovered date refuse with the applicable remedy context", async () => {
  for (const [override, message] of [["foreign-period", /foreign-period.*not available for this organization/], [null, /no accounting period covers 2026-09-20/]] as const) {
    const io = scripted([[]]);
    await assert.rejects(resolvePostingPeriod(io.runner, document(override), args.postingDate), (e: unknown) => e instanceof PostingError && message.test(e.message));
    io.done();
  }
});

test("root-currency payroll needs no consolidated exchange-rate reads", async () => {
  const io = scripted([root]);
  await assertPayRunConsolidatedRateCoverage(io.runner, { ...args, docCurrency: "USD" });
  io.done();
});

test("foreign payroll requires each differing-currency lineage pair in the posting period", async () => {
  const io = scripted([root, chain, period, [{ one: 1 }], [{ one: 1 }]]);
  await assertPayRunConsolidatedRateCoverage(io.runner, args);
  assert.deepEqual(io.calls[3]!.params, ["org-a", "period-a", "CAD", "EUR"]);
  assert.deepEqual(io.calls[4]!.params, ["org-a", "period-a", "EUR", "USD"]);
  io.done();
});

test("missing subsidiary and missing derived pair refuse instead of inventing a rate", async () => {
  const absent = scripted([root, []]);
  await assert.rejects(assertPayRunConsolidatedRateCoverage(absent.runner, args), /pay run subsidiary child does not exist/);
  absent.done();
  const missing = scripted([root, chain, period, []]);
  await assert.rejects(assertPayRunConsolidatedRateCoverage(missing.runner, args), /CAD → EUR.*2026-09-30.*Derive rates from period close first/);
  missing.done();
});

test("same-currency lineage hops require no redundant rate while other hops remain checked", async () => {
  const io = scripted([root, chain.map(row => row.id === "child" ? { ...row, base_currency: "EUR" } : row), period, [{ one: 1 }]]);
  await assertPayRunConsolidatedRateCoverage(io.runner, { ...args, docCurrency: "EUR" });
  assert.deepEqual(io.calls[3]!.params, ["org-a", "period-a", "EUR", "USD"]);
  io.done();
});
