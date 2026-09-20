import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { runScenario } from "./scenario.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Anti-false-green for the harness's kernel mirrors. `global-balance` and
 * `per-entry-balance` restate in SQL what PostgreSQL enforces on every write
 * (`jl_check_balanced`, exact, no tolerance) — so through every legitimate
 * write path they cannot fail, and a test that only posts legally can never
 * prove they bite. This file simulates the one scenario they exist for, a
 * kernel that stopped enforcing balance, by inserting an unbalanced posted
 * entry with enforcement triggers skipped for a single dedicated session
 * (`session_replication_role = 'replica'` touches nothing global: every other
 * session keeps full enforcement, and the role resets in a finally). The
 * balance mirrors must fail with the exact drift, AND so must every
 * dimensional check the drift genuinely violates — the book total (+1 on the
 * single book), the txn-currency total (+1, single currency), and the month
 * aggregate (replica also skips aggregate maintenance, the missed-rebuild
 * geometry) — while every unrelated check stays green; the fixture org
 * (imbalance included) is dropped afterwards.
 */

function check(cp: Awaited<ReturnType<typeof runScenario>>, name: string) {
  const c = cp.checks.find((c) => c.name === name);
  assert.ok(c, `checkpoint must carry the ${name} check`);
  return c;
}

test("global-balance and per-entry-balance fail on an unbalanced posted entry", { skip: !DB }, async (t) => {
  const org = await createScratchOrg();
  try {
    const client = new Client({ connectionString: process.env.OPENBOOKS_DB_URL });
    await client.connect();
    try {
      await client.query(`select set_config('app.bypass_rls', 'on', false)`);
      try {
        await client.query(`SET session_replication_role = 'replica'`);
      } catch (e) {
        // Simulating a non-enforcing kernel needs superuser. Honest skip
        // rather than a vacuous pass when the database user cannot.
        if ((e as { code?: string }).code === "42501") {
          t.skip("database user cannot disable enforcement triggers for the probe session");
          return;
        }
        throw e;
      }
      const entryId = randomUUID();
      const entryNumber = `BAL-PROBE-${entryId.slice(0, 8)}`;
      await client.query(
        `insert into journal_entries
           (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
         values ($1, $2, $3, $4, $5, $6, $7, 'kernel-bypass probe', 'posted', 'probe', '{}'::jsonb)`,
        [entryId, org.orgId, org.bookId, org.subsidiaryId, entryNumber, org.date, org.periodId],
      );
      // Deliberately unbalanced: +3.00 against −2.00. Plain P&L legs on a
      // non-control account, so no other harness check can see them.
      await client.query(
        `insert into journal_lines
           (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
         values ($1, $2, 1, $3, $4, '3.0000', 'CAD', '3.0000', 1, 'probe debit'),
                ($1, $2, 2, $3, $4, '-2.0000', 'CAD', '-2.0000', 1, 'probe credit')`,
        [org.orgId, entryId, org.accounts.cogs, org.subsidiaryId],
      );
    } finally {
      await client.query(`SET session_replication_role = 'origin'`).catch(() => {});
      await client.end();
    }

    const cp = await runScenario(org.orgId, { at: org.date });
    const gb = check(cp, "global-balance");
    assert.equal(gb.ok, false, `global balance MUST fail on the drifted ledger: ${gb.detail}`);
    assert.match(gb.detail, /1(\.0+)? \(want 0\)/, "detail must state the exact 1.00 drift");
    const pe = check(cp, "per-entry-balance");
    assert.equal(pe.ok, false, `per-entry balance MUST fail: ${pe.detail}`);
    assert.match(pe.detail, /^1 posted entries do not balance/, "detail must name the single broken entry");
    const pb = check(cp, "per-book-balance");
    assert.equal(pb.ok, false, `per-book balance MUST fail: ${pb.detail}`);
    assert.match(pb.detail, /worst \|Σ\| = 1\.0000 on PRI/, "detail must state the exact +1.00 book drift");
    const tx = check(cp, "per-entry-txn-balance");
    assert.equal(tx.ok, false, `txn balance MUST fail: ${tx.detail}`);
    assert.match(tx.detail, /1 posted entries do not balance in txn currency/);
    const ma = check(cp, "gl-month-activity-tieout");
    assert.equal(ma.ok, false, `month aggregate MUST fail: ${ma.detail}`);
    assert.match(ma.detail, /1 drifted from a direct sum/, "replica skips maintenance: the missed-rebuild geometry");
    assert.equal(cp.pass, false, "a drifted fixture cannot be golden");
    for (const other of cp.checks.filter(
      (c) => c.name !== "global-balance" && c.name !== "per-entry-balance" &&
        c.name !== "per-book-balance" && c.name !== "per-entry-txn-balance" &&
        c.name !== "gl-month-activity-tieout",
    )) {
      assert.equal(other.ok, true, `${other.name} must stay green here — only the balance/aggregate dimensions fire`);
    }
    // The drift is really stored (not a query artifact): direct recomputation agrees.
    const direct = await db.execute<{ s: string }>(sql`
      select coalesce(sum(l.amount), 0)::text as s from journal_lines l
        join journal_entries e on e.id = l.entry_id
       where l.org_id = ${org.orgId} and e.status in ('posted','reversed')`);
    assert.equal(Number(direct.rows[0]!.s), 1, "stored posted lines must sum to exactly 1.00");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
