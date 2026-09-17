import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  createMatch,
  importStatement,
  markReconciled,
  reconciliationTotals,
  startReconciliation,
} from "./banking.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "./test-fixtures.ts";

async function postBankJournal(
  org: ScratchOrg,
  actorId: string,
  bankAmounts: readonly string[],
  label: string,
  postingDate: string,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const entryId = randomUUID();
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`BANK-${label}-${entryId.slice(0, 8)}`}, ${postingDate}, ${org.periodId},
         ${`Bank reconciliation ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
    `);
    const bankLineIds: string[] = [];
    let lineNumber = 0;
    for (const amount of bankAmounts) {
      lineNumber += 1;
      const bankLineId = randomUUID();
      bankLineIds.push(bankLineId);
      await tx.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, memo)
        values
          (${bankLineId}, ${org.orgId}, ${entryId}, ${lineNumber},
           ${org.accounts.bank}, ${org.subsidiaryId}, ${amount}, 'CAD',
           ${amount}, 1, ${label})
      `);
      lineNumber += 1;
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, memo)
        values
          (${org.orgId}, ${entryId}, ${lineNumber}, ${org.accounts.adjustment},
           ${org.subsidiaryId}, ${`-${amount}`}, 'CAD',
           ${`-${amount}`}, 1, ${label})
      `);
    }
    await tx.execute(sql`
      update journal_entries
         set status = 'posted', posted_by = ${actorId}, updated_by = ${actorId}
       where id = ${entryId} and org_id = ${org.orgId}
    `);
    return bankLineIds;
  });
}

test(
  "a first reconciliation carries the imported statement opening into cleared",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Bank reviewer", "admin");
      const ctx = { orgId: org.orgId, userId: actor };
      await db.execute(sql`
        update accounts
           set reconcilable = true, currency_restriction = 'CAD'
         where id = ${org.accounts.bank} and org_id = ${org.orgId}
      `);

      await postBankJournal(org, actor, ["100"], "opening", "2026-07-01");
      const periodLines = await postBankJournal(org, actor, ["30"], "period", org.date);
      await importStatement(
        {
          accountId: org.accounts.bank,
          source: "manual",
          currency: "CAD",
          statementDate: org.date,
          openingBalance: "100",
          closingBalance: "130",
          lines: [
            {
              postedOn: org.date,
              amount: "30",
              description: "Period deposit",
              bankTransactionId: "first-recon-period-deposit",
            },
          ],
        },
        ctx,
      );
      const statementLineId = (await db.execute<{ id: string }>(sql`
        select id from bank_statement_lines where org_id = ${org.orgId}
      `)).rows[0]!.id;
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "130" },
        ctx,
      );
      await createMatch(
        { reconciliationId: recon.id, statementLineId, journalLineIds: periodLines },
        ctx,
      );

      assert.deepEqual(await reconciliationTotals(recon.id, ctx), {
        statementBalance: "130.0000",
        clearedBalance: "130.0000",
        difference: "0.0000",
        matchedStatementLines: 1,
        unmatchedStatementLines: 0,
        matchedJournalLines: 1,
      });
      assert.deepEqual(await markReconciled(recon.id, ctx), { journalLinesReconciled: 1 });
      const status = (await db.execute<{ status: string }>(sql`
        select status from reconciliations where org_id = ${org.orgId} and id = ${recon.id}
      `)).rows[0]!.status;
      assert.equal(status, "signed_off");
      const signoff = (await db.execute<{ changes: { openingCarriedForward: string; openingCarryStartDate: string } }>(sql`
        select changes from audit_log
         where org_id = ${org.orgId} and table_name = 'reconciliations' and row_id = ${recon.id}
           and action = 'approve'
      `)).rows[0]!.changes;
      assert.equal(signoff.openingCarriedForward, "100.0000");
      assert.equal(signoff.openingCarryStartDate, org.date);

      // The next session reuses the proven opening instead of re-matching
      // pre-statement history: cleared is opening + everything on/after
      // coverage start, and the carried lines stay out of matching.
      const period2 = await postBankJournal(org, actor, ["20"], "period-2", "2026-07-20");
      await importStatement(
        {
          accountId: org.accounts.bank,
          source: "manual",
          currency: "CAD",
          statementDate: "2026-07-20",
          openingBalance: "130",
          closingBalance: "150",
          lines: [
            {
              postedOn: "2026-07-20",
              amount: "20",
              description: "Second deposit",
              bankTransactionId: "second-recon-deposit",
            },
          ],
        },
        ctx,
      );
      const statement2Id = (await db.execute<{ id: string }>(sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and bank_transaction_id = 'second-recon-deposit'
      `)).rows[0]!.id;
      const recon2 = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: "2026-07-20", statementBalance: "150" },
        ctx,
      );
      await createMatch(
        { reconciliationId: recon2.id, statementLineId: statement2Id, journalLineIds: period2 },
        ctx,
      );
      assert.deepEqual(await reconciliationTotals(recon2.id, ctx), {
        statementBalance: "150.0000",
        clearedBalance: "150.0000",
        difference: "0.0000",
        matchedStatementLines: 1,
        unmatchedStatementLines: 0,
        matchedJournalLines: 1,
      });
      assert.deepEqual(await markReconciled(recon2.id, ctx), { journalLinesReconciled: 1 });
      const carriedStillOpen = (await db.execute<{ count: number }>(sql`
        select count(*)::int as count
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
         where jl.org_id = ${org.orgId} and jl.account_id = ${org.accounts.bank}
           and jl.reconciliation_id is null and je.posting_date < ${org.date}
      `)).rows[0]!.count;
      assert.equal(carriedStillOpen, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a first reconciliation refuses to invent an opening the ledger does not prove",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Bank reviewer", "admin");
      const ctx = { orgId: org.orgId, userId: actor };
      await db.execute(sql`
        update accounts
           set reconcilable = true, currency_restriction = 'CAD'
         where id = ${org.accounts.bank} and org_id = ${org.orgId}
      `);

      await postBankJournal(org, actor, ["100"], "opening", "2026-07-01");
      const periodLines = await postBankJournal(org, actor, ["30"], "period", org.date);
      await importStatement(
        {
          accountId: org.accounts.bank,
          source: "manual",
          currency: "CAD",
          statementDate: org.date,
          openingBalance: "90",
          closingBalance: "130",
          lines: [
            {
              postedOn: org.date,
              amount: "30",
              description: "Period deposit",
              bankTransactionId: "unproven-opening-deposit",
            },
          ],
        },
        ctx,
      );
      const statementLineId = (await db.execute<{ id: string }>(sql`
        select id from bank_statement_lines where org_id = ${org.orgId}
      `)).rows[0]!.id;
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "130" },
        ctx,
      );
      await createMatch(
        { reconciliationId: recon.id, statementLineId, journalLineIds: periodLines },
        ctx,
      );

      assert.deepEqual(await reconciliationTotals(recon.id, ctx), {
        statementBalance: "130.0000",
        clearedBalance: "30.0000",
        difference: "100.0000",
        matchedStatementLines: 1,
        unmatchedStatementLines: 0,
        matchedJournalLines: 1,
      });
      await assert.rejects(markReconciled(recon.id, ctx), /difference is 100\.0000/);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
