import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { runScenario } from "./scenario.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Anti-false-green for the harness's `per-entry-txn-balance` check — the
 * transaction-currency dimension of "every posted entry balances".
 *
 * The storage trigger pins the FUNCTIONAL amount per entry, and the line
 * check pins amount = round(txn × fx) per line, but nothing pins the txn
 * side per entry. Every entry on every cluster today is single-currency AND
 * single-rate, so the txn sums hold by habit, not by enforcement. The plant
 * below is a balanced-functional entry a mixed-rate future could produce —
 * DR 100 funded by a USD leg worth 100 functional — whose txn legs sum to
 * +60. The functional checks must stay green while only the txn gate fires.
 */

function check(cp: Awaited<ReturnType<typeof runScenario>>, name: string) {
  const c = cp.checks.find((c) => c.name === name);
  assert.ok(c, `checkpoint must carry the ${name} check`);
  return c;
}

test("per-entry-txn-balance fails on a functionally-balanced mixed-rate entry", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const entryId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`TXN-PROBE-${entryId.slice(0, 8)}`},
              ${org.date}, ${org.periodId}, 'txn red-proof probe', 'draft', 'manual', '{}'::jsonb)`);
    // One multi-row statement: the line guard requires the entry to balance
    // within each statement. Functional: 100 − 100 = 0. Txn: 100 − 40 = 60.
    await db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
      values (${org.orgId}, ${entryId}, 1, ${org.accounts.adjustment}, ${org.subsidiaryId}, '100.0000', 'CAD', '100.0000', 1, 'cad leg'),
             (${org.orgId}, ${entryId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId}, '-100.0000', 'USD', '-40.0000', 2.5, 'usd leg')`);
    await db.execute(sql`
      update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);

    const cp = await runScenario(org.orgId, { at: org.date });
    const txn = check(cp, "per-entry-txn-balance");
    assert.equal(txn.ok, false, `txn gate MUST fail: ${txn.detail}`);
    assert.match(txn.detail, /1 posted entries do not balance in txn currency/);
    assert.equal(cp.pass, false, "a txn-drifted fixture cannot be golden");
    for (const other of cp.checks.filter((c) => c.name !== "per-entry-txn-balance")) {
      assert.equal(other.ok, true, `${other.name} must stay green here — functional balance holds, only the txn dimension drifts`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
