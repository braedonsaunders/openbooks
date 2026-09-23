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
 * Anti-false-green for the harness's `open-balance-fresh` check. The stored
 * `documents.open_balance` is maintained by application code
 * (`recompute_document_open_balance` on every application) — no database
 * trigger refires it on a direct write to the column, and the posted-document
 * financial guard watches totals and identity, not the cached balance. The
 * harness recomputation is the backstop, so this test drifts the cache the
 * way a buggy writer would (a direct update no trigger intercepts) and
 * requires the check to fail with the exact stale row while everything else
 * stays green.
 *
 * Cutoff mechanics: with no closed period the harness cuts off at the end of
 * the month before the latest posting, so the drifted June document needs a
 * later July posting in the fixture (a balanced decoy) to stay in scope.
 */

function check(cp: Awaited<ReturnType<typeof runScenario>>, name: string) {
  const c = cp.checks.find((c) => c.name === name);
  assert.ok(c, `checkpoint must carry the ${name} check`);
  return c;
}

test("open-balance-fresh fails when the stored balance drifts from its lines", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const cal = await db.execute<{ id: string }>(sql`
      select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`);
    const junePeriodId = randomUUID();
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${junePeriodId}, ${org.orgId}, 2026, 6, '2026-06', '2026-06-01', '2026-06-30', false, ${cal.rows[0]!.id})`);

    // A balanced posted invoice: DR receivable 100 (open item) / CR revenue.
    const entryId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`OBF-PROBE-${entryId.slice(0, 8)}`},
              '2026-06-20', ${junePeriodId}, 'open-balance probe', 'draft', 'sales', '{}'::jsonb)`);
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
      values (${docId}, ${org.orgId}, 'customer_invoice', ${`OBF-${docId.slice(0, 8)}`}, '2026-06-20', 'CAD',
              '100.0000', '0.0000', '100.0000', ${org.customerId}, 'posted', ${entryId}, ${junePeriodId}, '100.0000')`);

    // Balanced July decoy so the cutoff (month before latest posting) keeps June in scope.
    const decoyId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
      values (${decoyId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`OBF-DECOY-${decoyId.slice(0, 8)}`},
              ${org.date}, ${org.periodId}, 'cutoff decoy', 'draft', 'probe', '{}'::jsonb)`);
    await db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
      values (${org.orgId}, ${decoyId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, '5.0000', 'CAD', '5.0000', 1, 'decoy'),
             (${org.orgId}, ${decoyId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId}, '-5.0000', 'CAD', '-5.0000', 1, 'decoy')`);
    await db.execute(sql`
      update journal_entries set status = 'posted', posted_at = now() where id = ${decoyId}`);

    // The drift: a direct write no trigger intercepts (guard only watches
    // totals/identity; the open-balance trigger fires on posted_entry_id and
    // status, never on the cached balance itself).
    await db.execute(sql`
      update documents set open_balance = '40.0000' where id = ${docId} and org_id = ${org.orgId}`);

    const cp = await runScenario(org.orgId, { at: org.date });
    const fresh = check(cp, "open-balance-fresh");
    assert.equal(fresh.ok, false, `open-balance-fresh MUST fail on the drifted cache: ${fresh.detail}`);
    assert.match(fresh.detail, /^1 .* stale open_balance/, "detail must name the single stale document");
    assert.equal(cp.pass, false, "a drifted fixture cannot be golden");
    for (const other of cp.checks.filter((c) => c.name !== "open-balance-fresh")) {
      assert.equal(other.ok, true, `${other.name} must stay green here — only the freshness gate fires`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/**
 * Migration 0100 denominates cached open balances in the DOCUMENT currency
 * (txn amounts minus source/target txn applied), not functional. A foreign
 * invoice whose stored balance is txn-correct must pass; the pre-0100
 * functional formula (145 CAD carrying vs 100 EUR stored) reads it as stale.
 * This test pins the document-currency behavior in both directions: correct
 * passes, drifted fails — while every other check stays green.
 */
async function foreignInvoice(org: Awaited<ReturnType<typeof createScratchOrg>>): Promise<{ docId: string }> {
  const cal = await db.execute<{ id: string }>(sql`
    select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`);
  const junePeriodId = randomUUID();
  await db.execute(sql`
    insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    values (${junePeriodId}, ${org.orgId}, 2026, 6, '2026-06', '2026-06-01', '2026-06-30', false, ${cal.rows[0]!.id})`);

  // EUR 100 invoice into a CAD-functional org at a commercial 1.45: the AR
  // leg carries 145 CAD functional with 100 EUR txn amounts.
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
    values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`OBF-FX-${entryId.slice(0, 8)}`},
            '2026-06-20', ${junePeriodId}, 'foreign open-balance probe', 'draft', 'sales', '{}'::jsonb)`);
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item, memo)
    values (${org.orgId}, ${entryId}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, '145.0000', 'EUR', '100.0000', '1.45', true, 'receivable'),
           (${org.orgId}, ${entryId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, '-145.0000', 'EUR', '-100.0000', '1.45', false, 'revenue')`);
  await db.execute(sql`
    update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
  const docId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, document_date, currency, fx_rate, subtotal, tax_total, total,
       party_id, status, posted_entry_id, posting_period_id, open_balance)
    values (${docId}, ${org.orgId}, 'customer_invoice', ${`OBF-FX-${docId.slice(0, 8)}`}, '2026-06-20', 'EUR', '1.45',
            '100.0000', '0.0000', '100.0000', ${org.customerId}, 'posted', ${entryId}, ${junePeriodId}, '100.0000')`);

  // Balanced July decoy so the cutoff (month before latest posting) keeps June in scope.
  const decoyId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
    values (${decoyId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`OBF-FXD-${decoyId.slice(0, 8)}`},
            ${org.date}, ${org.periodId}, 'cutoff decoy', 'draft', 'probe', '{}'::jsonb)`);
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
    values (${org.orgId}, ${decoyId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, '5.0000', 'CAD', '5.0000', 1, 'decoy'),
           (${org.orgId}, ${decoyId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId}, '-5.0000', 'CAD', '-5.0000', 1, 'decoy')`);
  await db.execute(sql`
    update journal_entries set status = 'posted', posted_at = now() where id = ${decoyId}`);
  return { docId };
}

test("open-balance-fresh passes a txn-correct foreign-currency balance", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await foreignInvoice(org);
    const cp = await runScenario(org.orgId, { at: org.date });
    const fresh = check(cp, "open-balance-fresh");
    assert.equal(fresh.ok, true, `a txn-correct foreign balance must pass: ${fresh.detail}`);
    assert.equal(cp.pass, true, "the foreign fixture is golden");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("open-balance-fresh fails a drifted foreign-currency balance", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { docId } = await foreignInvoice(org);
    await db.execute(sql`
      update documents set open_balance = '40.0000' where id = ${docId} and org_id = ${org.orgId}`);
    const cp = await runScenario(org.orgId, { at: org.date });
    const fresh = check(cp, "open-balance-fresh");
    assert.equal(fresh.ok, false, `open-balance-fresh MUST fail on the drifted foreign cache: ${fresh.detail}`);
    assert.match(fresh.detail, /^1 .* stale open_balance/, "detail must name the single stale document");
    assert.equal(cp.pass, false, "a drifted foreign fixture cannot be golden");
    for (const other of cp.checks.filter((c) => c.name !== "open-balance-fresh")) {
      assert.equal(other.ok, true, `${other.name} must stay green here — only the freshness gate fires`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
