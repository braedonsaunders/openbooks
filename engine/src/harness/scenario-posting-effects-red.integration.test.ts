import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { runScenario } from "../golden/scenario.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Anti-false-green for the harness's `posting-effects-drained` check. The
 * posting-effects outbox commits the journal before its downstream
 * projections run, so a poison effect parks as `terminal_failed` at the
 * attempt ceiling with the invoice posted and its cost side stranded. This
 * test plants exactly that geometry — a balanced posted invoice whose
 * effect row carries the full terminal envelope — and requires the drain
 * check to fail naming the single terminal row while every other check
 * stays green.
 */

function check(cp: Awaited<ReturnType<typeof runScenario>>, name: string) {
  const c = cp.checks.find((c) => c.name === name);
  assert.ok(c, `checkpoint must carry the ${name} check`);
  return c;
}

test("posting-effects-drained fails on a terminal-failed effect with its document posted", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // A balanced posted invoice: DR receivable 100 (open item) / CR revenue.
    const entryId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`PED-PROBE-${entryId.slice(0, 8)}`},
              ${org.date}, ${org.periodId}, 'posting-effects drain probe', 'draft', 'sales', '{}'::jsonb)`);
    await db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item, memo)
      values (${org.orgId}, ${entryId}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, '100.0000', 'CAD', '100.0000', 1, true, 'receivable'),
             (${org.orgId}, ${entryId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, '-100.0000', 'CAD', '-100.0000', 1, false, 'revenue')`);
    await db.execute(sql`
      update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
    const docId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, document_date, currency, subtotal, tax_total, total,
         party_id, status, posted_entry_id, posting_period_id, open_balance)
      values (${docId}, ${org.orgId}, 'customer_invoice', ${`PED-${docId.slice(0, 8)}`}, ${org.date}, 'CAD',
              '100.0000', '0.0000', '100.0000', ${org.customerId}, 'posted', ${entryId}, ${org.periodId}, '100.0000')`);

    // The stranded effect: eight attempts exhausted, cost side never ran.
    await db.execute(sql`
      insert into posting_effects
        (org_id, document_id, kind, entry_id, posting_date, status, attempt_count,
         error, terminal_failure_reason, terminal_failed_at, terminal_failed_by)
      values (${org.orgId}, ${docId}, 'customer_invoice', ${entryId}, ${org.date},
              'terminal_failed', 8, 'probe: inventory issue failed',
              'probe: inventory issue failed', now(), 'harness-probe')`);

    const cp = await runScenario(org.orgId, { at: org.date });
    const drained = check(cp, "posting-effects-drained");
    assert.equal(drained.ok, false, `posting-effects-drained MUST fail on the stranded effect: ${drained.detail}`);
    assert.match(drained.detail, /1 terminal-failed/, "detail must name the single terminal row");
    assert.equal(cp.pass, false, "a stranded fixture cannot be golden");
    for (const other of cp.checks.filter((c) => c.name !== "posting-effects-drained")) {
      assert.equal(other.ok, true, `${other.name} must stay green here — only the drain gate fires`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
