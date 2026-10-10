import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  autoMatch,
  createMatch,
  importStatement,
  listSignOffBlockers,
  markReconciled,
  startReconciliation,
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

async function postCardJournal(
  org: ScratchOrg,
  actorId: string,
  bankAmount: string,
  date: string,
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
         ${`CARD-${label}-${entryId.slice(0, 8)}`}, ${date}, ${org.periodId},
         ${`Card ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
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

async function setup(accountType: string) {
  const org = await createScratchOrg();
  const actor = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update accounts
       set type = ${accountType}, reconcilable = true, currency_restriction = 'CAD'
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

async function lineStatus(orgId: string, lineId: string): Promise<string> {
  return (await db.execute<{ match_status: string }>(sql`
    select match_status from bank_statement_lines where org_id = ${orgId} and id = ${lineId}
  `)).rows[0]!.match_status;
}

async function matchedPairs(orgId: string, reconId: string) {
  return (await db.execute<{ statement_line_id: string | null; journal_line_id: string }>(sql`
    select statement_line_id, journal_line_id from reconciliation_matches
     where org_id = ${orgId} and reconciliation_id = ${reconId}
  `)).rows;
}

test(
  "opposite-sign charge matches and signs off owing-positive on a card account",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup("liability_card");
    try {
      // A $1,236.90 card charge — the portal prints it
      // owing-positive while the GL carries the credit (-1,236.90).
      const journal = await postCardJournal(org, actor, "-1236.90", org.date, "charge");
      const imported = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [
            { postedOn: org.date, amount: "1236.90", description: "Card charge", bankTransactionId: "card-charge" },
          ],
        },
        ctx,
      );
      const [charge] = await statementLineIds(org.orgId, imported.statementId!);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "1236.90" },
        ctx,
      );

      // A cent-apart pairing still refuses naming both totals.
      const other = await postCardJournal(org, actor, "-50.00", org.date, "other");
      await assert.rejects(
        createMatch(
          { reconciliationId: recon.id, statementLineIds: [charge!], journalLineIds: [other!] },
          ctx,
        ),
        /Selected bank lines total 1236\.9000; selected journal lines total -50\.0000/,
      );

      const totals = await createMatch(
        { reconciliationId: recon.id, statementLineIds: [charge!], journalLineIds: [journal!] },
        ctx,
      );
      assert.equal(totals.difference, "0.0000", "the opposite-sign pair clears the session");
      assert.equal(totals.clearedBalance, "1236.9000", "the cleared balance reads owing-positive");
      const signed = await markReconciled(recon.id, ctx);
      assert.equal(signed.journalLinesReconciled, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "same-sign OFX-style pair still matches and signs off at a negative balance",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup("liability_card");
    try {
      // OFX carries card charges GL-signed: statement and GL agree directly,
      // and the typed balance is negative. That working flow must survive.
      const journal = await postCardJournal(org, actor, "-500.00", org.date, "ofx-charge");
      const imported = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [
            { postedOn: org.date, amount: "-500.00", description: "Card charge", bankTransactionId: "ofx-charge" },
          ],
        },
        ctx,
      );
      const [charge] = await statementLineIds(org.orgId, imported.statementId!);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "-500.00" },
        ctx,
      );
      const totals = await createMatch(
        { reconciliationId: recon.id, statementLineIds: [charge!], journalLineIds: [journal!] },
        ctx,
      );
      assert.equal(totals.difference, "0.0000");
      const signed = await markReconciled(recon.id, ctx);
      assert.equal(signed.journalLinesReconciled, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "asset accounts still refuse opposite-sign pairs",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup("asset_bank");
    try {
      const journal = await postCardJournal(org, actor, "-100.00", org.date, "mismatch");
      const imported = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [
            { postedOn: org.date, amount: "100.00", description: "Deposit", bankTransactionId: "deposit" },
          ],
        },
        ctx,
      );
      const [deposit] = await statementLineIds(org.orgId, imported.statementId!);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "100.00" },
        ctx,
      );
      await assert.rejects(
        createMatch(
          { reconciliationId: recon.id, statementLineIds: [deposit!], journalLineIds: [journal!] },
          ctx,
        ),
        /Selected bank lines total 100\.0000; selected journal lines total -100\.0000/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "auto-match pairs the opposite-sign exact-date charge and never the opening row",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup("liability_card");
    try {
      // A bare Nov-1 "Opening 1,914.90" row names no balance word, so the
      // conservative import keeps it as a transaction line — but it still
      // has no GL counterpart, and auto-match must never pair it with the
      // same-amount Nov-12 payment. The Nov-12 charge pairs its same-day
      // GL across the sign convention instead.
      const payment = await postCardJournal(org, actor, "1914.90", "2026-11-12", "payment");
      const charge = await postCardJournal(org, actor, "-500.00", "2026-11-12", "charge");
      const imported = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: "2026-11-30",
          currency: "CAD",
          lines: [
            { postedOn: "2026-11-01", amount: "1914.90", description: "Opening 1,914.90", bankTransactionId: "opening" },
            { postedOn: "2026-11-12", amount: "500.00", description: "Store purchase", bankTransactionId: "purchase" },
          ],
        },
        ctx,
      );
      assert.equal(imported.imported, 2, "the bare opening row imports as a line");
      const [opening, purchase] = await statementLineIds(org.orgId, imported.statementId!);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: "2026-11-30", statementBalance: "2414.90" },
        ctx,
      );
      const result = await autoMatch(recon.id, ctx);
      assert.equal(result.matched, 1, "only the charge pairs");
      const pairs = await matchedPairs(org.orgId, recon.id);
      assert.deepEqual(
        pairs,
        [{ statement_line_id: purchase!, journal_line_id: charge! }],
        "the exact-date opposite-sign pair wins",
      );
      assert.equal(await lineStatus(org.orgId, opening!), "unmatched", "the opening row stays for review");
      assert.ok(
        !pairs.some((pair) => pair.journal_line_id === payment!),
        "the same-amount payment stays free",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "sign-off blockers list the unmatched lines oldest first",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup("asset_bank");
    try {
      const journal = await postCardJournal(org, actor, "500.00", "2026-11-05", "same-day");
      const imported = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: "2026-11-30",
          currency: "CAD",
          lines: [
            { postedOn: "2026-11-04", amount: "500.00", description: "Earlier receipt", bankTransactionId: "earlier" },
            { postedOn: "2026-11-05", amount: "500.00", description: "Same-day receipt", bankTransactionId: "same-day" },
          ],
        },
        ctx,
      );
      const [earlier, sameDay] = await statementLineIds(org.orgId, imported.statementId!);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: "2026-11-30", statementBalance: "1000.00" },
        ctx,
      );
      await createMatch(
        { reconciliationId: recon.id, statementLineIds: [sameDay!], journalLineIds: [journal!] },
        ctx,
      );
      const blockers = await listSignOffBlockers(recon.id, ctx);
      assert.equal(blockers.total, 1, "the matched line is not a blocker");
      assert.deepEqual(
        blockers.lines.map((line) => line.id),
        [earlier!],
        "only the unmatched line blocks, oldest first",
      );
      assert.equal(blockers.lines[0]!.amount, "500.0000");
      assert.equal(blockers.lines[0]!.description, "Earlier receipt");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a far line never steals the journal a same-day line needs",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup("asset_bank");
    try {
      const journal = await postCardJournal(org, actor, "500.00", "2026-11-05", "same-day");
      const imported = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: "2026-11-30",
          currency: "CAD",
          lines: [
            { postedOn: "2026-11-04", amount: "500.00", description: "Earlier receipt", bankTransactionId: "earlier" },
            { postedOn: "2026-11-05", amount: "500.00", description: "Same-day receipt", bankTransactionId: "same-day" },
          ],
        },
        ctx,
      );
      const [earlier, sameDay] = await statementLineIds(org.orgId, imported.statementId!);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: "2026-11-30", statementBalance: "1000.00" },
        ctx,
      );
      const result = await autoMatch(recon.id, ctx);
      assert.equal(result.matched, 1, "only the same-day line pairs");
      assert.deepEqual(await matchedPairs(org.orgId, recon.id), [
        { statement_line_id: sameDay!, journal_line_id: journal! },
      ]);
      assert.equal(await lineStatus(org.orgId, earlier!), "unmatched");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
