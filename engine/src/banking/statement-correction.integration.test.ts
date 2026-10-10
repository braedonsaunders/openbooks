import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  BankingError,
  clearPossibleDuplicateFlag,
  correctStatementLine,
  createMatch,
  deleteStatementImport,
  excludeStatementLine,
  importStatement,
  markReconciled,
  restoreStatementLine,
  startReconciliation,
  unmatchStatementLine,
} from "./banking.ts";
import { db } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

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
         ${`Bank correction ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
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

async function setup() {
  const org = await createScratchOrg();
  const actor = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update accounts
       set reconcilable = true, currency_restriction = 'CAD'
     where id = ${org.accounts.bank} and org_id = ${org.orgId}
  `);
  const ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };
  return { org, actor, ctx };
}

async function lineIdByRef(orgId: string, statementId: string, ref: string): Promise<string> {
  const row = (await db.execute<{ id: string }>(sql`
    select id from bank_statement_lines
     where org_id = ${orgId} and statement_id = ${statementId} and bank_transaction_id = ${ref}
  `)).rows[0];
  assert.ok(row, `imported line ${ref} must exist`);
  return row.id;
}

async function lineIdByContent(
  orgId: string,
  statementId: string,
  postedOn: string,
  amount: string,
  description: string,
): Promise<string> {
  const row = (await db.execute<{ id: string }>(sql`
    select id from bank_statement_lines
     where org_id = ${orgId} and statement_id = ${statementId}
       and posted_on = ${postedOn} and amount = ${amount} and description = ${description}
  `)).rows[0];
  assert.ok(row, `imported line ${postedOn} ${amount} ${description} must exist`);
  return row.id;
}

async function lineRow(lineId: string, orgId: string) {
  return (await db.execute<{
    amount: string;
    posted_on: string;
    description: string | null;
    match_status: string;
  }>(sql`
    select amount::text as amount, posted_on::text as posted_on, description, match_status
      from bank_statement_lines where id = ${lineId} and org_id = ${orgId}
  `)).rows[0];
}

async function auditRows(table: string, rowId: string, orgId: string) {
  return (await db.execute<{ action: string; changes: unknown }>(sql`
    select action, changes from audit_log
     where org_id = ${orgId} and table_name = ${table} and row_id = ${rowId}
     order by id
  `)).rows;
}

async function journalEntryCount(orgId: string): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where org_id = ${orgId}
  `)).rows[0]!.n;
}

test(
  "an unmatched line's sign error corrects with before/after audit and posts nothing",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      const imported = await importStatement(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [
            { postedOn: org.date, amount: "-100", description: "Deposit recorded backwards", bankTransactionId: "sign-flip-100" },
          ],
        },
        ctx,
      );
      const lineId = await lineIdByRef(org.orgId, imported.statementId!, "sign-flip-100");
      const entriesBefore = await journalEntryCount(org.orgId);

      // The QA case: a sign error that manual matching refuses on opposite
      // signs. Correcting the sign must not book an adjusting entry.
      await correctStatementLine(lineId, { amount: "100" }, ctx);

      const row = await lineRow(lineId, org.orgId);
      assert.equal(row!.amount, "100");
      assert.equal(await journalEntryCount(org.orgId), entriesBefore, "a correction posts no journal entry");
      const audits = await auditRows("bank_statement_lines", lineId, org.orgId);
      assert.equal(audits.length, 1, "one audit row records the correction");
      const changes = audits[0]!.changes as { operation: string; before: unknown; after: unknown };
      assert.equal(changes.operation, "correct_line");
      assert.deepEqual(changes.before, { amount: "-100", postedOn: org.date, description: "Deposit recorded backwards" });
      assert.deepEqual(changes.after, { amount: "100", postedOn: org.date, description: "Deposit recorded backwards" });

      // Repeating the identical correction is idempotent success, not a
      // second audit row.
      await correctStatementLine(lineId, { amount: "100.00" }, ctx);
      assert.equal((await auditRows("bank_statement_lines", lineId, org.orgId)).length, 1);
      void actor;
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "correction refuses matched and excluded lines with named remedies",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      const journals = await postBankJournal(org, actor, ["40.0000"], "correct-guard");
      const imported = await importStatement(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [
            { postedOn: org.date, amount: "40", description: "To match", bankTransactionId: "guard-40" },
            { postedOn: org.date, amount: "7", description: "To exclude", bankTransactionId: "guard-7" },
          ],
        },
        ctx,
      );
      const matchedId = await lineIdByRef(org.orgId, imported.statementId!, "guard-40");
      const excludedId = await lineIdByRef(org.orgId, imported.statementId!, "guard-7");
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "40" },
        ctx,
      );
      await createMatch({ reconciliationId: recon.id, statementLineIds: [matchedId], journalLineIds: journals }, ctx);
      await excludeStatementLine(excludedId, "Fee the bookkeeper records directly", ctx);

      await assert.rejects(
        correctStatementLine(matchedId, { amount: "41" }, ctx),
        (error: unknown) => error instanceof BankingError && /unmatch it first/.test(error.message),
      );
      await assert.rejects(
        correctStatementLine(excludedId, { amount: "8" }, ctx),
        (error: unknown) => error instanceof BankingError && /restore it first/.test(error.message),
      );

      // The remedies work: unmatch and restore reopen the correction path.
      await unmatchStatementLine({ reconciliationId: recon.id, statementLineId: matchedId }, ctx);
      await correctStatementLine(matchedId, { amount: "41" }, ctx);
      assert.equal((await lineRow(matchedId, org.orgId))!.amount, "41");
      await restoreStatementLine(excludedId, ctx);
      await correctStatementLine(excludedId, { amount: "8" }, ctx);
      assert.equal((await lineRow(excludedId, org.orgId))!.amount, "8");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "correction refuses into signed-off history but stays open after the cutoff",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      const journals = await postBankJournal(org, actor, ["25.0000"], "signoff-guard");
      const first = await importStatement(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [{ postedOn: org.date, amount: "25", description: "Signed period", bankTransactionId: "signoff-25" }],
        },
        ctx,
      );
      const signedId = await lineIdByRef(org.orgId, first.statementId!, "signoff-25");
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "25" },
        ctx,
      );
      await createMatch({ reconciliationId: recon.id, statementLineIds: [signedId], journalLineIds: journals }, ctx);
      await markReconciled(recon.id, ctx);

      // A later import is fenced to dates after the cutoff; moving one back
      // in is refused, while an amount fix beside it succeeds.
      const dayAfter = new Date(`${org.date}T00:00:00Z`);
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
      const afterCutoff = dayAfter.toISOString().slice(0, 10);
      const second = await importStatement(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: afterCutoff,
          currency: "CAD",
          lines: [{ postedOn: afterCutoff, amount: "-9", description: "After cutoff", bankTransactionId: "after-cutoff-9" }],
        },
        ctx,
      );
      const laterId = await lineIdByRef(org.orgId, second.statementId!, "after-cutoff-9");
      await assert.rejects(
        correctStatementLine(laterId, { postedOn: org.date }, ctx),
        (error: unknown) => error instanceof BankingError && /signed-off history is immutable/.test(error.message),
      );
      await correctStatementLine(laterId, { amount: "-10", description: "After cutoff, fixed" }, ctx);
      const row = await lineRow(laterId, org.orgId);
      assert.equal(row!.amount, "-10");
      assert.equal(row!.description, "After cutoff, fixed");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an untouched import deletes with per-row audit and frees its re-import",
  { skip: !DB },
  async () => {
    const { org, ctx } = await setup();
    try {
      const input = {
        accountId: org.accounts.bank,
        source: "csv" as const,
        statementDate: org.date,
        currency: "CAD",
        lines: [
          { postedOn: org.date, amount: "60", description: "Wrong file", bankTransactionId: "doomed-60" },
          { postedOn: org.date, amount: "-11", description: "Wrong file fee", bankTransactionId: "doomed-11" },
        ],
      };
      const imported = await importStatement(input, ctx);
      const statementId = imported.statementId!;
      const entriesBefore = await journalEntryCount(org.orgId);

      const result = await deleteStatementImport(statementId, ctx);
      assert.deepEqual(result, { deletedLines: 2 });

      const remaining = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from bank_statement_lines where org_id = ${org.orgId} and statement_id = ${statementId}
      `);
      assert.equal(remaining.rows[0]!.n, 0, "every imported line goes with the import");
      const header = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from bank_statements where org_id = ${org.orgId} and id = ${statementId}
      `);
      assert.equal(header.rows[0]!.n, 0, "the statement header goes too");
      assert.equal(await journalEntryCount(org.orgId), entriesBefore, "a delete posts nothing");

      const headerAudits = await auditRows("bank_statements", statementId, org.orgId);
      assert.equal(headerAudits.length, 1, "the import delete is audited on the statement");
      const headerChanges = headerAudits[0]!.changes as { operation: string; before: { lineCount: number } };
      assert.equal(headerChanges.operation, "delete_import");
      assert.equal(headerChanges.before.lineCount, 2);

      // The sha backstop otherwise refuses the same file as a duplicate: the
      // delete is what frees an honest re-import.
      const retry = await importStatement(input, ctx);
      assert.equal(retry.imported, 2, "the same file re-imports after its bad import is deleted");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "delete refuses matched, excluded and duplicate-flagged imports with named remedies",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      const journals = await postBankJournal(org, actor, ["33.0000"], "delete-guard");
      const imported = await importStatement(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [
            { postedOn: org.date, amount: "33", description: "To match" },
            { postedOn: org.date, amount: "4", description: "To exclude", bankTransactionId: "del-guard-4" },
          ],
        },
        ctx,
      );
      const statementId = imported.statementId!;
      const matchedId = await lineIdByContent(org.orgId, statementId, org.date, "33", "To match");
      const excludedId = await lineIdByRef(org.orgId, statementId, "del-guard-4");
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "33" },
        ctx,
      );
      await createMatch({ reconciliationId: recon.id, statementLineIds: [matchedId], journalLineIds: journals }, ctx);
      await excludeStatementLine(excludedId, "Duplicate confirmed by the counterparty advice", ctx);

      await assert.rejects(
        deleteStatementImport(statementId, ctx),
        (error: unknown) => error instanceof BankingError && /unmatch them first/.test(error.message),
      );
      await unmatchStatementLine({ reconciliationId: recon.id, statementLineId: matchedId }, ctx);
      await assert.rejects(
        deleteStatementImport(statementId, ctx),
        (error: unknown) => error instanceof BankingError && /restore them first/.test(error.message),
      );
      await restoreStatementLine(excludedId, ctx);

      // A later import's identical id-less line flags as a possible duplicate
      // of this import's line. That pointer is the later line's review
      // evidence: it blocks the delete until cleared.
      const later = await importStatement(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [{ postedOn: org.date, amount: "33", description: "To match" }],
        },
        ctx,
      );
      assert.equal(later.possibleDuplicates, 1, "the repeated id-less line flags, not dedupes");
      const flaggedId = await lineIdByContent(org.orgId, later.statementId!, org.date, "33", "To match");
      const flag = (await db.execute<{ possible_duplicate_of: string | null }>(sql`
        select possible_duplicate_of from bank_statement_lines where id = ${flaggedId} and org_id = ${org.orgId}
      `)).rows[0]!.possible_duplicate_of;
      assert.equal(flag, matchedId, "the flag points at this import's line");
      await assert.rejects(
        deleteStatementImport(statementId, ctx),
        (error: unknown) => error instanceof BankingError && /clear those flags first/.test(error.message),
      );
      await clearPossibleDuplicateFlag(flaggedId, ctx);

      const result = await deleteStatementImport(statementId, ctx);
      assert.deepEqual(result, { deletedLines: 2 });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "correction and delete stay tenant-scoped",
  { skip: !DB },
  async () => {
    const { org, ctx } = await setup();
    const other = await createScratchOrg();
    try {
      const imported = await importStatement(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [{ postedOn: org.date, amount: "12", description: "Mine", bankTransactionId: "scoped-12" }],
        },
        ctx,
      );
      const lineId = await lineIdByRef(org.orgId, imported.statementId!, "scoped-12");
      const foreign = { orgId: other.orgId, userId: ctx.userId, allowedSubsidiaryIds: null };
      await assert.rejects(correctStatementLine(lineId, { amount: "13" }, foreign));
      await assert.rejects(deleteStatementImport(imported.statementId!, foreign));
      assert.equal((await lineRow(lineId, org.orgId))!.amount, "12", "the foreign attempt changes nothing");
    } finally {
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(other.orgId);
    }
  },
);
