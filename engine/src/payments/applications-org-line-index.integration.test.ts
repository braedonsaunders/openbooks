// source-pin-contract: published migration 0150 is executed from its immutable bytes, and EXPLAIN proves small-tenant OR probes use the org-leading composite indexes, idempotent on rerun
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

/**
 * Migration 0150: org-leading composites on applications.
 *
 * Per-line open-balance probes (module-home customers/purchasing, cash
 * open-items, payments) correlate `org_id = $org AND (to_line_id = $line OR
 * from_line_id = $line)`. The only line-leading indexes were app_from/app_to,
 * so a small tenant's probe BitmapOr-ed over the majority tenant's index
 * entries with the org applied as a late filter. The composites bind each OR
 * arm to the probing tenant's own slice.
 */

const BIG_ROWS = 5000;
const SMALL_ROWS = 5;

async function seedApplications(org: {
  orgId: string;
  bookId: string;
  periodId: string;
  subsidiaryId: string;
  date: string;
  accounts: Record<string, string>;
}, n: number): Promise<void> {
  // Plain-table staging: every step reads committed tables, so no DML-CTE
  // visibility quirks and no client-side id plumbing.
  //
  // Seeded in CHUNKS, not one statement per step. Every row here fires the
  // per-row journal triggers (balance, account, subsidiary and the gl-activity
  // aggregate), so 5,000 entries plus 10,000 lines in a single INSERT took
  // ~146s on a CI runner against the 120s client query_timeout in db.ts and
  // failed as a read timeout — a fixture cost reported as a product failure.
  // The chunk size changes only how the work is divided: the row counts, and
  // therefore the statistics the planner discriminates on, are identical.
  const CHUNK = 500;
  for (let lo = 1; lo <= n; lo += CHUNK) {
    const hi = Math.min(lo + CHUNK - 1, n);
    await db.execute(sql`
      INSERT INTO journal_entries (org_id, book_id, entry_number, posting_date, period_id, subsidiary_id, status, origin)
      SELECT ${org.orgId}::uuid, ${org.bookId}::uuid, 'seed-' || g, ${org.date}::date,
             ${org.periodId}::uuid, ${org.subsidiaryId}::uuid, 'draft', 'manual'
      FROM generate_series(${lo}::int, ${hi}::int) g`);
    await db.execute(sql`
      INSERT INTO journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
      SELECT ${org.orgId}::uuid, je.id, 1, ${org.accounts.bank}::uuid, ${org.subsidiaryId}::uuid,
             10, 'CAD', 10, 1, true
        FROM journal_entries je
       WHERE je.org_id = ${org.orgId}::uuid AND je.entry_number LIKE 'seed-%'
         AND substring(je.entry_number from 6)::int BETWEEN ${lo}::int AND ${hi}::int
      UNION ALL
      SELECT ${org.orgId}::uuid, je.id, 2, ${org.accounts.bank}::uuid, ${org.subsidiaryId}::uuid,
             -10, 'CAD', -10, 1, true
        FROM journal_entries je
       WHERE je.org_id = ${org.orgId}::uuid AND je.entry_number LIKE 'seed-%'
         AND substring(je.entry_number from 6)::int BETWEEN ${lo}::int AND ${hi}::int`);
    await db.execute(sql`
      UPDATE journal_entries SET status = 'posted', posted_at = now()
       WHERE org_id = ${org.orgId}::uuid AND entry_number LIKE 'seed-%'
         AND substring(entry_number from 6)::int BETWEEN ${lo}::int AND ${hi}::int`);
  }
  // Cross-entry pairs (line 2 of entry k settles line 1 of entry k+1): same
  // account/party/subsidiary, opposite signs, both posted open items.
  await db.execute(sql`
    INSERT INTO applications (org_id, from_line_id, to_line_id, amount, applied_on, source_amount,
      source_transaction_amount, source_transaction_currency, target_transaction_amount,
      target_transaction_currency, settlement_rate, settlement_rate_source, settlement_rate_reference)
    SELECT ${org.orgId}::uuid, f.id, t.id, 5, ${org.date}::date, 5, 5, 'CAD', 5, 'CAD',
           1, 'same_currency', 'seed'
      FROM (SELECT jl.id, substring(je.entry_number from 6)::int AS g
              FROM journal_lines jl
              JOIN journal_entries je ON je.id = jl.entry_id
             WHERE jl.org_id = ${org.orgId}::uuid AND jl.line_number = 2
               AND je.entry_number LIKE 'seed-%') f
      JOIN (SELECT jl.id, substring(je.entry_number from 6)::int AS g
              FROM journal_lines jl
              JOIN journal_entries je ON je.id = jl.entry_id
             WHERE jl.org_id = ${org.orgId}::uuid AND jl.line_number = 1
               AND je.entry_number LIKE 'seed-%') t
        ON t.g = f.g % ${n} + 1`);
}

async function probePlan(smallOrgId: string, lineId: string): Promise<string> {
  const r = await db.execute<Record<string, string>>(sql`
    EXPLAIN (COSTS OFF) select sum(x.amount) from applications x
     where x.org_id = ${smallOrgId}
       and (x.to_line_id = ${lineId} or x.from_line_id = ${lineId})
       and x.unapplied_at is null`);
  return r.rows.map((row) => row["QUERY PLAN"] ?? "").join("\n");
}

test("small-tenant application OR-probes use the org-leading composite indexes", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const big = await createScratchOrg();
  const small = await createScratchOrg();
  try {
    await seedApplications(big, BIG_ROWS);
    await seedApplications(small, SMALL_ROWS);
    const smallLine = (await db.execute<{ id: string }>(sql`
      select jl.id from journal_lines jl where jl.org_id = ${small.orgId} limit 1`)).rows[0]!.id;
    const migration = readFileSync(
      "schema/migrations/generated/0150_applications_org_line_indexes.sql", "utf8");

    // Red: without the composites the probe BitmapOrs the tenant-blind
    // single-column arms with the org as a late filter.
    await db.execute(sql`DROP INDEX IF EXISTS applications_org_from_idx`);
    await db.execute(sql`DROP INDEX IF EXISTS applications_org_to_idx`);
    await db.execute(sql`ANALYZE applications`);
    const before = await probePlan(small.orgId, smallLine);
    assert.doesNotMatch(before, /applications_org_(from|to)_idx/);
    assert.match(before, /BitmapOr/, "pre-migration probe must show the tenant-blind arms");
    assert.match(before, /Bitmap Index Scan on app_(from|to)/);

    // Green: applying the migration file (twice, proving idempotence) moves
    // the probe onto the org-leading composite.
    for (let pass = 0; pass < 2; pass++) {
      const client = await pool.connect();
      try {
        await client.query(migration);
      } finally {
        client.release();
      }
    }
    await db.execute(sql`ANALYZE applications`);
    const after = await probePlan(small.orgId, smallLine);
    assert.match(after, /applications_org_(from|to)_idx/);
    assert.doesNotMatch(after, /Seq Scan on applications/);
    assert.doesNotMatch(after, /BitmapOr/);
  } finally {
    await dropScratchOrg(big.orgId);
    await dropScratchOrg(small.orgId);
  }
});
