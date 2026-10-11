import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  correctStatementBalances,
  createGlClearingGroup,
  createMatch,
  deleteStatementImport,
  importStatement,
  markReconciled,
  startReconciliation,
  unmatchStatementImport,
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
  date?: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const entryId = randomUUID();
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`BAL-${label}-${entryId.slice(0, 8)}`}, ${date ?? org.date}, ${org.periodId},
         ${`Balance ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
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

async function storedBalances(orgId: string, statementId: string) {
  return (await db.execute<{ opening_balance: string | null; closing_balance: string | null }>(sql`
    select opening_balance::text as opening_balance, closing_balance::text as closing_balance
      from bank_statements where id = ${statementId} and org_id = ${orgId}
  `)).rows[0]!;
}

test(
  "CSV balances are set on the imported statement before any match, audited",
  { skip: !DB },
  async () => {
    const { org, ctx } = await setup();
    try {
      // A CSV carries no bank-reported balances, so the statement imports
      // with none — the operator sets them before matching starts.
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
      assert.deepEqual(await storedBalances(org.orgId, imported.statementId!), {
        opening_balance: null,
        closing_balance: null,
      });
      const after = await correctStatementBalances(
        imported.statementId!,
        { openingBalance: "1000.00", closingBalance: "1100.00" },
        ctx,
      );
      assert.deepEqual(after, { openingBalance: "1000.0000", closingBalance: "1100.0000" });
      assert.deepEqual(await storedBalances(org.orgId, imported.statementId!), {
        opening_balance: "1000.0000",
        closing_balance: "1100.0000",
      });
      const audits = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from audit_log
         where org_id = ${org.orgId} and table_name = 'bank_statements'
           and row_id = ${imported.statementId!} and action = 'update'
           and changes->>'operation' = 'correct_balances'
      `)).rows[0]!.n;
      assert.equal(audits, 1, "the balance correction is audited with a before/after image");
      await assert.rejects(
        correctStatementBalances(imported.statementId!, {}, ctx),
        /No balance supplied/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "statement balances refuse once a line is matched",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      const journal = await postBankLine(org, actor, "100.00", "receipt");
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
      const [receipt] = (await db.execute<{ id: string }>(sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and statement_id = ${imported.statementId!}
      `)).rows.map((row) => row.id);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "100.00" },
        ctx,
      );
      await createMatch(
        { reconciliationId: recon.id, statementLineIds: [receipt!], journalLineIds: [journal!] },
        ctx,
      );
      await assert.rejects(
        correctStatementBalances(imported.statementId!, { closingBalance: "100.00" }, ctx),
        /unmatch them first/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "pre-carry book lines clear as a zero-sum group while the carry still proves",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      // A 5,000.00 book opening with no bank line predates the statement
      // coverage, as does a voided 200.00 deposit and its correction.
      await postBankLine(org, actor, "5000.00", "book-opening", "2026-10-01");
      const voided = await postBankLine(org, actor, "200.00", "voided-deposit", "2026-10-02");
      const correction = await postBankLine(org, actor, "-200.00", "correction", "2026-10-03");
      const receipt = await postBankLine(org, actor, "300.00", "receipt", "2026-11-05");
      const imported = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: "2026-11-30",
          currency: "CAD",
          openingBalance: "5000.00",
          lines: [
            { postedOn: "2026-11-05", amount: "300.00", description: "Client receipt", bankTransactionId: "receipt" },
          ],
        },
        ctx,
      );
      const [receiptLine] = (await db.execute<{ id: string }>(sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and statement_id = ${imported.statementId!}
      `)).rows.map((row) => row.id);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: "2026-11-30", statementBalance: "5300.00" },
        ctx,
      );
      await createMatch(
        { reconciliationId: recon.id, statementLineIds: [receiptLine!], journalLineIds: [receipt!] },
        ctx,
      );
      // The pre-carry pair nets to zero, so clearing it cannot double-count
      // the 5,000.00 opening the carry proves from the same history.
      await createGlClearingGroup(
        { reconciliationId: recon.id, journalLineIds: [voided!, correction!] },
        ctx,
      );
      const signed = await markReconciled(recon.id, ctx);
      assert.equal(signed.journalLinesReconciled, 3, "receipt plus both cleared lines stamp");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "unmatch-all releases an import so its delete succeeds",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      const first = await postBankLine(org, actor, "100.00", "first");
      const second = await postBankLine(org, actor, "200.00", "second");
      const imported = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [
            { postedOn: org.date, amount: "100.00", description: "First receipt", bankTransactionId: "first" },
            { postedOn: org.date, amount: "200.00", description: "Second receipt", bankTransactionId: "second" },
          ],
        },
        ctx,
      );
      const lineIds = (await db.execute<{ id: string }>(sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and statement_id = ${imported.statementId!}
         order by line_number
      `)).rows.map((row) => row.id);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "300.00" },
        ctx,
      );
      await createMatch(
        { reconciliationId: recon.id, statementLineIds: lineIds, journalLineIds: [first!, second!] },
        ctx,
      );
      await assert.rejects(
        deleteStatementImport(imported.statementId!, ctx),
        /unmatch them first/,
      );
      const released = await unmatchStatementImport(imported.statementId!, ctx);
      assert.equal(released.unmatchedGroups, 1);
      assert.equal(released.unmatchedLines, 2);
      const deleted = await deleteStatementImport(imported.statementId!, ctx);
      assert.equal(deleted.deletedLines, 2, "the released import deletes");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "unmatch-all refuses inside signed-off history",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      const journal = await postBankLine(org, actor, "100.00", "receipt");
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
      const [receipt] = (await db.execute<{ id: string }>(sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and statement_id = ${imported.statementId!}
      `)).rows.map((row) => row.id);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "100.00" },
        ctx,
      );
      await createMatch(
        { reconciliationId: recon.id, statementLineIds: [receipt!], journalLineIds: [journal!] },
        ctx,
      );
      await markReconciled(recon.id, ctx);
      await assert.rejects(
        unmatchStatementImport(imported.statementId!, ctx),
        /signed-off history is immutable/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
