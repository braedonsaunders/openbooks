import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { cmp } from "./money.ts";
import { payRunFunding } from "./payroll-readiness.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "./test-fixtures.ts";

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
): Promise<string> {
  const entryId = randomUUID();
  const offsetAmount = bankAmount.startsWith("-") ? bankAmount.slice(1) : `-${bankAmount}`;
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
       period_id, memo, status, origin, created_by, updated_by)
    values
      (${entryId}, ${org.orgId}, ${bookId ?? org.bookId}, ${org.subsidiaryId},
       ${`FUND-${label}-${entryId.slice(0, 8)}`}, ${org.date}, ${org.periodId},
       ${`Funding balance ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
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

async function fundingBankBalance(org: ScratchOrg): Promise<string> {
  const funding = await payRunFunding(org.orgId, randomUUID());
  const account = funding.accounts.find((a) => a.id === org.accounts.bank);
  assert.ok(account, "the fixture bank account must appear in funding");
  return account.balance;
}

test("funding nets a voided transfer instead of counting only its reversal (F-t05-004)", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Payroll controller", "admin");
    const original = await postFundingJournal(org, actor, "5000", "transfer");
    await db.execute(sql`update journal_entries set status = 'reversed' where id = ${original} and org_id = ${org.orgId}`);
    await postFundingJournal(org, actor, "-5000", "transfer-void");

    // The ledger nets the void pair to zero; funding must read the same.
    assert.equal(cmp(await ledgerBankBalance(org), "0"), 0);
    assert.equal(cmp(await fundingBankBalance(org), "0"), 0);
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

    assert.equal(cmp(await ledgerBankBalance(org), "0"), 0);
    assert.equal(cmp(await fundingBankBalance(org), "0"), 0);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
