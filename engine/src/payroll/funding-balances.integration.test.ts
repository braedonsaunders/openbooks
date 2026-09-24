import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp } from "../money/money.ts";
import { payRunFunding } from "./readiness.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "../testing/fixtures.ts";

/**
 * Pay-run funding balances must read the ledger like every other surface.
 *
 * F-t05-004: the pay-run Funding panel showed 1010 at -$5,000.00 while the
 * banking roster showed $0.00 (and 1000 $2,500 apart) — a voided transfer
 * whose reversal the funding query counted while ignoring the voided
 * original it negates. The funding lateral read `status = 'posted'` with no
 * book scope; the ledger reader (banking roster, GL summary, conformance)
 * reads posted + reversed in the primary posting book.
 */

async function postFundingJournal(
  org: ScratchOrg,
  actorId: string,
  bankAmount: string,
  label: string,
  bookId?: string,
  reversesEntryId?: string,
): Promise<string> {
  const entryId = randomUUID();
  const offsetAmount = bankAmount.startsWith("-") ? bankAmount.slice(1) : `-${bankAmount}`;
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
       period_id, memo, status, origin, reverses_entry_id, created_by, updated_by)
    values
      (${entryId}, ${org.orgId}, ${bookId ?? org.bookId}, ${org.subsidiaryId},
       ${`FUND-${label}-${entryId.slice(0, 8)}`}, ${org.date}, ${org.periodId},
       ${`Funding balance ${label}`}, 'draft', 'manual', ${reversesEntryId ?? null},
       ${actorId}, ${actorId})
  `);
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id,
       amount, currency, txn_amount, fx_rate, memo)
    values
      (${org.orgId}, ${entryId}, 1, ${org.accounts.bank},
       ${org.subsidiaryId}, ${bankAmount}, 'CAD', ${bankAmount}, 1, ${label}),
      (${org.orgId}, ${entryId}, 2, ${org.accounts.clearing},
       ${org.subsidiaryId}, ${offsetAmount}, 'CAD', ${offsetAmount}, 1, ${label})
  `);
  await db.execute(sql`
    update journal_entries
       set status = 'posted', posted_by = ${actorId}, updated_by = ${actorId}
     where id = ${entryId} and org_id = ${org.orgId}
  `);
  return entryId;
}

/** The ledger's own bank balance: posted + reversed, primary book. */
async function ledgerBankBalance(org: ScratchOrg): Promise<string> {
  const rows = await db.execute<{ balance: string }>(sql`
    select coalesce(sum(jl.amount), 0)::text as balance
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       and je.status in ('posted', 'reversed')
       and je.book_id = (select b.id from accounting_books b
                          where b.org_id = ${org.orgId} and b.is_primary
                          order by b.created_at limit 1)
     where jl.org_id = ${org.orgId} and jl.account_id = ${org.accounts.bank}`);
  return rows.rows[0]!.balance;
}

/**
 * Funding is per-run since the missing-run refusal: the balance legs under
 * test need a real run to read through. The assertions below are unchanged —
 * only the setup names a run instead of a random id.
 */
async function fundingRun(org: ScratchOrg, actorId: string): Promise<string> {
  await db.execute(sql`
    update orgs set settings = settings || '{"features":{"payroll":true}}'::jsonb
     where id = ${org.orgId}`);
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);
  const run = await createPayRun({
    orgId: org.orgId, actorId, payScheduleId: scheduleId,
    periodStart: "2026-07-05", periodEnd: "2026-07-18",
  });
  return run.documentId;
}

async function fundingBankBalance(org: ScratchOrg, documentId: string): Promise<string> {
  const funding = await payRunFunding(org.orgId, documentId);
  const account = funding.accounts.find((a) => a.id === org.accounts.bank);
  assert.ok(account, "the fixture bank account must appear in funding");
  return account.balance;
}

test("funding nets a voided transfer instead of counting only its reversal (F-t05-004)", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Payroll controller", "admin");
    const original = await postFundingJournal(org, actor, "5000", "transfer");
    // 0166/0168 require a posted mirror in the same book before the original
    // may flip to reversed. Post the void first, then retire the original.
    await postFundingJournal(org, actor, "-5000", "transfer-void", undefined, original);
    await db.execute(sql`update journal_entries set status = 'reversed' where id = ${original} and org_id = ${org.orgId}`);

    // The ledger nets the void pair to zero; funding must read the same.
    const documentId = await fundingRun(org, actor);
    assert.equal(cmp(await ledgerBankBalance(org), "0"), 0);
    assert.equal(cmp(await fundingBankBalance(org, documentId), "0"), 0);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("funding excludes secondary-book postings like the banking roster", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Payroll controller", "admin");
    const secondary = randomUUID();
    await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values(${secondary},${org.orgId},'TAX','Tax',false,true,true)`);
    await postFundingJournal(org, actor, "2000", "tax-book", secondary);

    const documentId = await fundingRun(org, actor);
    assert.equal(cmp(await ledgerBankBalance(org), "0"), 0);
    assert.equal(cmp(await fundingBankBalance(org, documentId), "0"), 0);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
