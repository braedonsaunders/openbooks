import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  BankingError,
  createGlClearingGroup,
  createMatch,
  importStatement,
  markReconciled,
  startReconciliation,
  unmatchGlClearingGroup,
} from "./banking.ts";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type CsvImportInput = Omit<Parameters<typeof importStatement>[0], "source" | "sourceEvidence"> & {
  source: "csv";
};

/**
 * Import fixture lines as the bank CSV file they stand for. CSV imports must
 * retain the column mapping used to parse the file, so the fixture renders
 * the lines into deterministic CSV bytes with that mapping: an identical
 * input reproduces the identical file (and source hash).
 */
function importCsv(input: CsvImportInput, ctx: Parameters<typeof importStatement>[1]) {
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const content =
    [
      "date,amount,description,bank_transaction_id",
      ...input.lines.map((line) =>
        [line.postedOn, line.amount, quote(line.description ?? ""), line.bankTransactionId ?? ""].join(","),
      ),
    ].join("\n") + "\n";
  return importStatement(
    {
      ...input,
      sourceEvidence: {
        content,
        filename: "statement.csv",
        contentType: "text/csv",
        csvMapping: { date: 0, amount: 1, description: 2, bankTransactionId: 3 },
      },
    },
    ctx,
  );
}

async function postBankLine(
  org: ScratchOrg,
  actorId: string,
  bankAmount: string,
  label: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const entryId = randomUUID();
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`GLC-${label}-${entryId.slice(0, 8)}`}, ${org.date}, ${org.periodId},
         ${`GL clearing ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
    `);
    const offsetAmount = bankAmount.startsWith("-") ? bankAmount.slice(1) : `-${bankAmount}`;
    const [bankLine] = (await tx.execute<{ id: string }>(sql`
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, subsidiary_id,
         amount, currency, txn_amount, fx_rate, memo)
      values
        (${randomUUID()}, ${org.orgId}, ${entryId}, 1,
         ${org.accounts.bank}, ${org.subsidiaryId}, ${bankAmount}, 'CAD',
         ${bankAmount}, 1, ${label}),
        (${randomUUID()}, ${org.orgId}, ${entryId}, 2,
         ${org.accounts.adjustment}, ${org.subsidiaryId}, ${offsetAmount}, 'CAD',
         ${offsetAmount}, 1, ${label})
      returning id
    `)).rows;
    await tx.execute(sql`
      update journal_entries
         set status = 'posted', posted_by = ${actorId}, updated_by = ${actorId}
       where id = ${entryId} and org_id = ${org.orgId}
    `);
    return bankLine!.id;
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

async function groupOf(orgId: string, reconId: string, journalLineId: string): Promise<string | null> {
  return (await db.execute<{ group_id: string }>(sql`
    select group_id from reconciliation_matches
     where org_id = ${orgId} and reconciliation_id = ${reconId} and journal_line_id = ${journalLineId}
  `)).rows[0]?.group_id ?? null;
}

test(
  "a voided deposit and its correcting journal clear as a zero-sum group",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      // A +271.20 voided deposit and its -271.20 correction net
      // to zero with no bank line to match against.
      const receipt = await postBankLine(org, actor, "100.00", "receipt");
      const voided = await postBankLine(org, actor, "271.20", "voided-deposit");
      const correction = await postBankLine(org, actor, "-271.20", "correction");
      const imported = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [
            { postedOn: org.date, amount: "100.00", description: "Client receipt", bankTransactionId: "receipt" },
          ],
        },
        ctx,
      );
      const [receiptLine] = await statementLineIds(org.orgId, imported.statementId!);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "100.00" },
        ctx,
      );
      await createMatch(
        { reconciliationId: recon.id, statementLineIds: [receiptLine!], journalLineIds: [receipt!] },
        ctx,
      );

      // A non-zero selection refuses naming its total.
      await assert.rejects(
        createGlClearingGroup({ reconciliationId: recon.id, journalLineIds: [voided!] }, ctx),
        /Selected journal lines total 271\.2000, not zero/,
      );
      await assert.rejects(
        createGlClearingGroup({ reconciliationId: recon.id, journalLineIds: [] }, ctx),
        /Select at least one journal line/,
      );

      const totals = await createGlClearingGroup(
        { reconciliationId: recon.id, journalLineIds: [voided!, correction!] },
        ctx,
      );
      assert.equal(totals.difference, "0.0000", "a zero-sum group leaves the difference untouched");

      // Claimed journals cannot be matched elsewhere.
      await assert.rejects(
        createGlClearingGroup({ reconciliationId: recon.id, journalLineIds: [voided!, correction!] }, ctx),
        /unavailable, outside the cutoff, already reconciled, or already matched/,
      );

      const signed = await markReconciled(recon.id, ctx);
      assert.equal(signed.journalLinesReconciled, 3, "receipt plus both cleared lines stamp");

      // Signed-off groups are immutable through both verbs.
      const groupId = await groupOf(org.orgId, recon.id, voided!);
      assert.ok(groupId);
      await assert.rejects(
        unmatchGlClearingGroup({ reconciliationId: recon.id, groupId: groupId! }, ctx),
        /already signed off/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a clearing group unmatches by id and its journals clear again",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      const receipt = await postBankLine(org, actor, "100.00", "receipt");
      const voided = await postBankLine(org, actor, "271.20", "voided-deposit");
      const correction = await postBankLine(org, actor, "-271.20", "correction");
      const imported = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [
            { postedOn: org.date, amount: "100.00", description: "Client receipt", bankTransactionId: "receipt" },
          ],
        },
        ctx,
      );
      const [receiptLine] = await statementLineIds(org.orgId, imported.statementId!);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "100.00" },
        ctx,
      );
      await createMatch(
        { reconciliationId: recon.id, statementLineIds: [receiptLine!], journalLineIds: [receipt!] },
        ctx,
      );
      await createGlClearingGroup(
        { reconciliationId: recon.id, journalLineIds: [voided!, correction!] },
        ctx,
      );
      const groupId = (await groupOf(org.orgId, recon.id, voided!))!;
      assert.ok(groupId);

      // A statement-backed group is refused here: it unmatches by line.
      const stmtGroup = (await db.execute<{ group_id: string }>(sql`
        select group_id from reconciliation_matches
         where org_id = ${org.orgId} and reconciliation_id = ${recon.id}
           and statement_line_id is not null limit 1
      `)).rows[0]!.group_id;
      await assert.rejects(
        unmatchGlClearingGroup({ reconciliationId: recon.id, groupId: stmtGroup }, ctx),
        /unmatch it from one of its statement lines/,
      );
      await assert.rejects(
        unmatchGlClearingGroup({ reconciliationId: recon.id, groupId: randomUUID() }, ctx),
        /No clearing group with that id/,
      );

      await unmatchGlClearingGroup({ reconciliationId: recon.id, groupId }, ctx);
      assert.equal(await groupOf(org.orgId, recon.id, voided!), null, "the group goes together");
      await createGlClearingGroup(
        { reconciliationId: recon.id, journalLineIds: [voided!, correction!] },
        ctx,
      );
      const signed = await markReconciled(recon.id, ctx);
      assert.equal(signed.journalLinesReconciled, 3);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "sign-off cross-foots a clearing group that stopped summing to zero",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      const receipt = await postBankLine(org, actor, "100.00", "receipt");
      const voided = await postBankLine(org, actor, "271.20", "voided-deposit");
      const correction = await postBankLine(org, actor, "-271.20", "correction");
      const imported = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [
            { postedOn: org.date, amount: "100.00", description: "Client receipt", bankTransactionId: "receipt" },
          ],
        },
        ctx,
      );
      const [receiptLine] = await statementLineIds(org.orgId, imported.statementId!);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "100.00" },
        ctx,
      );
      await createMatch(
        { reconciliationId: recon.id, statementLineIds: [receiptLine!], journalLineIds: [receipt!] },
        ctx,
      );
      await createGlClearingGroup(
        { reconciliationId: recon.id, journalLineIds: [voided!, correction!] },
        ctx,
      );
      // A later cent sneaks onto the correction: the group no longer foots.
      await db.execute(sql`
        update journal_lines set txn_amount = '-271.19' where id = ${correction!} and org_id = ${org.orgId}
      `);
      await assert.rejects(markReconciled(recon.id, ctx), BankingError);
      await assert.rejects(markReconciled(recon.id, ctx), /does not foot/);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
