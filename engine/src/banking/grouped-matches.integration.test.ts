import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  BankingError,
  createMatch,
  importStatement,
  markReconciled,
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
         ${`Bank group match ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
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
  return { org, actor, ctx: { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null } };
}

async function statementLineIds(orgId: string, statementId: string): Promise<string[]> {
  return (await db.execute<{ id: string }>(sql`
    select id from bank_statement_lines
     where org_id = ${orgId} and statement_id = ${statementId}
     order by line_number
  `)).rows.map((row) => row.id);
}

async function matchRows(orgId: string, reconId: string) {
  return (await db.execute<{ statement_line_id: string; journal_line_id: string; group_id: string }>(sql`
    select statement_line_id, journal_line_id, group_id from reconciliation_matches
     where org_id = ${orgId} and reconciliation_id = ${reconId}
  `)).rows;
}

async function lineStatus(orgId: string, lineId: string): Promise<string> {
  return (await db.execute<{ match_status: string }>(sql`
    select match_status from bank_statement_lines where org_id = ${orgId} and id = ${lineId}
  `)).rows[0]!.match_status;
}

test(
  "two wires clear one journal as a group, sign off, and unmatch as a group",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      // The QA case: one $8,000 journal paying two partners, two $4,000 wires.
      const [journal] = await postBankJournal(org, actor, ["8000.0000"], "two-partners");
      const imported = await importStatement(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [
            { postedOn: org.date, amount: "4000", description: "Wire partner A", bankTransactionId: "wire-a" },
            { postedOn: org.date, amount: "4000", description: "Wire partner B", bankTransactionId: "wire-b" },
          ],
        },
        ctx,
      );
      const [wireA, wireB] = await statementLineIds(org.orgId, imported.statementId!);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "8000" },
        ctx,
      );

      const totals = await createMatch(
        { reconciliationId: recon.id, statementLineIds: [wireA!, wireB!], journalLineIds: [journal!] },
        ctx,
      );
      assert.equal(totals.difference, "0.0000", "the grouped match clears the session");
      const rows = await matchRows(org.orgId, recon.id);
      assert.equal(rows.length, 2, "one row per grouped bank line");
      assert.equal(new Set(rows.map((row) => row.group_id)).size, 1, "one operation writes one group");
      assert.equal(await lineStatus(org.orgId, wireA!), "matched");
      assert.equal(await lineStatus(org.orgId, wireB!), "matched");

      // Unmatching either member restores the whole group: both wires return
      // and the journal is claimable again.
      await unmatchStatementLine({ reconciliationId: recon.id, statementLineId: wireB! }, ctx);
      assert.equal((await matchRows(org.orgId, recon.id)).length, 0, "the group goes together");
      assert.equal(await lineStatus(org.orgId, wireA!), "unmatched");
      assert.equal(await lineStatus(org.orgId, wireB!), "unmatched");
      await createMatch(
        { reconciliationId: recon.id, statementLineIds: [wireA!, wireB!], journalLineIds: [journal!] },
        ctx,
      );
      assert.equal((await matchRows(org.orgId, recon.id)).length, 2, "the released group re-matches");

      // The group cross-foots at sign-off as the unit it cleared as, and the
      // closed session keeps its fence.
      await markReconciled(recon.id, ctx);
      await assert.rejects(
        unmatchStatementLine({ reconciliationId: recon.id, statementLineId: wireA! }, ctx),
        /already signed off/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "one deposit clears three receipts with one shared audit group",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      const receipts = await postBankJournal(org, actor, ["100.0000", "100.0000", "100.0000"], "three-receipts");
      const imported = await importStatement(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [{ postedOn: org.date, amount: "300", description: "Batch deposit", bankTransactionId: "batch-300" }],
        },
        ctx,
      );
      const [deposit] = await statementLineIds(org.orgId, imported.statementId!);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "300" },
        ctx,
      );

      await createMatch(
        { reconciliationId: recon.id, statementLineIds: [deposit!], journalLineIds: receipts },
        ctx,
      );
      const rows = await matchRows(org.orgId, recon.id);
      assert.equal(rows.length, 3, "one row per receipt leg");
      assert.equal(new Set(rows.map((row) => row.group_id)).size, 1, "one operation writes one group");

      const audits = (await db.execute<{ changes: unknown }>(sql`
        select changes from audit_log
         where org_id = ${org.orgId} and table_name = 'bank_statement_lines'
           and row_id = ${deposit!} and action = 'update'
         order by id
      `)).rows;
      assert.equal(audits.length, 1, "one audit row per grouped line");
      const changes = audits[0]!.changes as { operation: string; groupId: string; statementLineIds: string[]; journalLineIds: string[] };
      assert.equal(changes.operation, "match");
      assert.equal(changes.groupId, rows[0]!.group_id, "the audit names the group");
      assert.deepEqual(changes.statementLineIds, [deposit!]);
      assert.deepEqual([...changes.journalLineIds].sort(), [...receipts].sort());

      // Unmatching the single deposit releases all three receipts.
      await unmatchStatementLine({ reconciliationId: recon.id, statementLineId: deposit! }, ctx);
      assert.equal((await matchRows(org.orgId, recon.id)).length, 0, "the group goes together");
      assert.equal(await lineStatus(org.orgId, deposit!), "unmatched");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a cent-apart group refuses naming both totals",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      const [journal] = await postBankJournal(org, actor, ["7999.9900"], "cent-short");
      const imported = await importStatement(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [
            { postedOn: org.date, amount: "4000", description: "Wire A", bankTransactionId: "cent-a" },
            { postedOn: org.date, amount: "4000", description: "Wire B", bankTransactionId: "cent-b" },
          ],
        },
        ctx,
      );
      const [wireA, wireB] = await statementLineIds(org.orgId, imported.statementId!);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "8000" },
        ctx,
      );

      await assert.rejects(
        createMatch(
          { reconciliationId: recon.id, statementLineIds: [wireA!, wireB!], journalLineIds: [journal!] },
          ctx,
        ),
        (error: unknown) =>
          error instanceof BankingError
          && /Selected bank lines total 8000\.0000; selected journal lines total 7999\.9900/.test(error.message),
      );
      assert.equal((await matchRows(org.orgId, recon.id)).length, 0, "a refused group writes nothing");
      assert.equal(await lineStatus(org.orgId, wireA!), "unmatched");
      assert.equal(await lineStatus(org.orgId, wireB!), "unmatched");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
