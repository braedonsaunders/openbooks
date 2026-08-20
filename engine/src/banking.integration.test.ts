import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  autoMatch,
  BankingError,
  createMatch,
  discardReconciliation,
  excludeStatementLine,
  importStatement,
  markReconciled,
  reconciliationTotals,
  restoreStatementLine,
  startReconciliation,
  unmatchStatementLine,
} from "./banking.ts";
import { db } from "./db.ts";
import { fromUnits, toUnits } from "./money.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (pattern.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

async function postBankJournal(
  org: ScratchOrg,
  actorId: string,
  bankAmounts: readonly string[],
  label: string,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const entryId = randomUUID();
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`BANK-${label}-${entryId.slice(0, 8)}`}, ${org.date}, ${org.periodId},
         ${`Bank reconciliation ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
    `);
    const bankLineIds: string[] = [];
    let lineNumber = 0;
    for (const amount of bankAmounts) {
      const offsetAmount = fromUnits(-toUnits(amount));
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
           ${org.subsidiaryId}, ${offsetAmount}, 'CAD',
           ${offsetAmount}, 1, ${label})
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
  "bank reconciliation is exact, race-safe, tenant-scoped, auditable, and immutable after sign-off",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const otherOrg = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const otherActor = (await seedFlowActors(otherOrg.orgId)).adminId;
      await db.execute(sql`
        update accounts
           set reconcilable = true, currency_restriction = 'CAD'
         where id = ${org.accounts.bank} and org_id = ${org.orgId}
      `);
      await db.execute(sql`
        update accounts
           set reconcilable = true, currency_restriction = 'CAD'
         where id = ${otherOrg.accounts.bank} and org_id = ${otherOrg.orgId}
      `);

      const hundred = await postBankJournal(org, actor, ["100.0000"], "deposit");
      const splitWithdrawal = await postBankJournal(
        org,
        actor,
        ["-5.0000", "-15.0000"],
        "split-withdrawal",
      );
      const otherTenantLine = await postBankJournal(
        otherOrg,
        otherActor,
        ["100.0000"],
        "other-tenant",
      );

      const statementInput = {
        accountId: org.accounts.bank,
        source: "ofx" as const,
        statementDate: org.date,
        openingBalance: "0",
        closingBalance: "80",
        currency: "CAD",
        lines: [
          {
            postedOn: org.date,
            amount: "100",
            description: "Customer deposit",
            bankTransactionId: "bank-deposit-100",
          },
          {
            postedOn: org.date,
            amount: "-20",
            description: "Split withdrawal",
            bankTransactionId: "bank-withdrawal-20",
          },
          {
            postedOn: org.date,
            amount: "5",
            description: "Documented duplicate",
            bankTransactionId: "bank-excluded-5",
          },
        ],
      };
      const imports = await Promise.all([
        importStatement(statementInput, { orgId: org.orgId, userId: actor }),
        importStatement(statementInput, { orgId: org.orgId, userId: actor }),
      ]);
      assert.equal(imports.filter((result) => result.statementId !== null).length, 1);
      assert.equal(imports.reduce((count, result) => count + result.imported, 0), 3);
      assert.equal(imports.reduce((count, result) => count + result.duplicates, 0), 3);

      const statementRows = (await db.execute<{ id: string; bank_transaction_id: string }>(sql`
        select id, bank_transaction_id
          from bank_statement_lines
         where org_id = ${org.orgId} and account_id = ${org.accounts.bank}
         order by bank_transaction_id
      `));
      assert.equal(statementRows.rows.length, 3);
      const statementByRef = new Map(
        statementRows.rows.map((row) => [row.bank_transaction_id, row.id]),
      );

      const starts = await Promise.allSettled([
        startReconciliation(
          {
            accountId: org.accounts.bank,
            throughDate: org.date,
            statementBalance: "80",
          },
          { orgId: org.orgId, userId: actor },
        ),
        startReconciliation(
          {
            accountId: org.accounts.bank,
            throughDate: org.date,
            statementBalance: "80",
          },
          { orgId: org.orgId, userId: actor },
        ),
      ]);
      const fulfilled = starts.filter(
        (result): result is PromiseFulfilledResult<{ id: string }> =>
          result.status === "fulfilled",
      );
      assert.equal(fulfilled.length, 1);
      assert.equal(
        starts.filter((result) => result.status === "rejected").length,
        1,
      );
      const reconciliationId = fulfilled[0].value.id;
      const ctx = { orgId: org.orgId, userId: actor };

      const automatic = await autoMatch(reconciliationId, ctx);
      assert.equal(automatic.matched, 1);
      assert.equal(automatic.highConfidence, 1);

      const withdrawalId = statementByRef.get("bank-withdrawal-20")!;
      await assert.rejects(
        createMatch(
          {
            reconciliationId,
            statementLineId: withdrawalId,
            journalLineIds: [splitWithdrawal[0]],
          },
          ctx,
        ),
        /total -5\.0000; the statement line is -20\.0000/,
      );
      await assert.rejects(
        createMatch(
          {
            reconciliationId,
            statementLineId: withdrawalId,
            journalLineIds: otherTenantLine,
          },
          ctx,
        ),
        /unavailable/,
      );
      await createMatch(
        {
          reconciliationId,
          statementLineId: withdrawalId,
          journalLineIds: splitWithdrawal,
        },
        ctx,
      );

      await assert.rejects(
        markReconciled(reconciliationId, ctx),
        /remain unmatched/,
      );
      const excludedId = statementByRef.get("bank-excluded-5")!;
      await assert.rejects(
        excludeStatementLine(excludedId, "bad", ctx),
        (error: unknown) =>
          error instanceof BankingError && /between 5 and 500/.test(error.message),
      );
      await excludeStatementLine(
        excludedId,
        "Duplicate confirmed by the bank statement issuer",
        ctx,
      );
      await restoreStatementLine(excludedId, ctx);
      await excludeStatementLine(
        excludedId,
        "Duplicate confirmed by the bank statement issuer",
        ctx,
      );

      const totals = await reconciliationTotals(reconciliationId, ctx);
      assert.deepEqual(totals, {
        statementBalance: "80.0000",
        clearedBalance: "80.0000",
        difference: "0.0000",
        matchedStatementLines: 2,
        unmatchedStatementLines: 0,
        matchedJournalLines: 3,
      });
      const signoffs = await Promise.all([
        markReconciled(reconciliationId, ctx),
        markReconciled(reconciliationId, ctx),
      ]);
      assert.deepEqual(signoffs, [
        { journalLinesReconciled: 3 },
        { journalLinesReconciled: 3 },
      ]);

      await assert.rejects(
        unmatchStatementLine(
          {
            reconciliationId,
            statementLineId: statementByRef.get("bank-deposit-100")!,
          },
          ctx,
        ),
        /signed off/,
      );
      await assert.rejects(
        discardReconciliation(reconciliationId, ctx),
        /Signed-off reconciliations cannot be discarded/,
      );
      await assert.rejects(
        restoreStatementLine(excludedId, ctx),
        /covered by a signed-off reconciliation/,
      );
      await assert.rejects(
        db.execute(sql`
          update journal_lines
             set reconciled_at = null, reconciliation_id = null
           where id = ${hundred[0]} and org_id = ${org.orgId}
        `),
        (error: unknown) =>
          errorChainMatches(error, /reconciliation evidence is append-only/),
      );
      await assert.rejects(
        db.execute(sql`
          delete from reconciliation_matches
           where reconciliation_id = ${reconciliationId}
             and journal_line_id = ${hundred[0]}
        `),
        (error: unknown) =>
          errorChainMatches(error, /signed-off reconciliation matches are immutable/),
      );
      await assert.rejects(
        db.execute(sql`
          update bank_statement_lines
             set amount = '999.0000'
           where id = ${statementByRef.get("bank-deposit-100")!}
             and org_id = ${org.orgId}
        `),
        (error: unknown) =>
          errorChainMatches(error, /statement (content|evidence) is immutable/),
      );

      const evidence = (await db.execute<{
          exclusions: number;
          restores: number;
          signoffs: number;
          stamped: number;
        }>(sql`
        select
          (select count(*)::int
             from audit_log
            where org_id = ${org.orgId}
              and table_name = 'bank_statement_lines'
              and row_id = ${excludedId}
              and changes->>'operation' = 'exclude') as exclusions,
          (select count(*)::int
             from audit_log
            where org_id = ${org.orgId}
              and table_name = 'bank_statement_lines'
              and row_id = ${excludedId}
              and changes->>'operation' = 'restore_exclusion') as restores,
          (select count(*)::int
             from audit_log
            where org_id = ${org.orgId}
              and table_name = 'reconciliations'
              and row_id = ${reconciliationId}
              and action = 'approve') as signoffs,
          (select count(*)::int
             from journal_lines
            where org_id = ${org.orgId}
              and reconciliation_id = ${reconciliationId}
              and reconciled_at is not null) as stamped
      `));
      assert.deepEqual(evidence.rows[0], {
        exclusions: 2,
        restores: 1,
        signoffs: 1,
        stamped: 3,
      });
      assert.equal(hundred.length, 1);
    } finally {
      await dropScratchOrg(otherOrg.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);
