import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  importStatement,
  createMatch,
  markReconciled,
  parseCsv,
  parseOfx,
  startReconciliation,
} from "./banking.ts";
import { db } from "../platform/db.ts";
import { isBalanceSummaryRow } from "./statement-parsers/shared.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const MAPPING = { date: 0, amount: 1, description: 2 };

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

test("CSV tags a dated opening-balance row instead of importing it as a transaction", () => {
  const parsed = parseCsv(
    ["Date,Amount,Description", "2026-11-01,3068.57,Opening balance", "2026-11-02,-45.00,Card payment"].join("\n"),
    MAPPING,
  );
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[0]!.balanceHint, "opening");
  assert.equal(parsed.lines[0]!.amount, "3068.5700");
  assert.equal(parsed.lines[1]!.balanceHint, null);
  assert.deepEqual(parsed.skipped, []);
});

test("CSV balance roles follow the direction word, and a bare balance is a transaction", () => {
  const descriptions: [string, unknown][] = [
    ["Closing balance", "closing"],
    ["Balance c/f", "closing"],
    ["Previous balance", "opening"],
    ["Balance b/f", "opening"],
    ["Balance", null],
    ["Monthly balance fee", null],
  ];
  for (const [description, role] of descriptions) {
    const parsed = parseCsv(`Date,Amount,Description\n2026-11-01,10.00,${description}`, MAPPING);
    assert.equal(parsed.lines[0]!.balanceHint, role, description);
  }
});

test("CSV sets aside a dateless opening-balance row as a balance skip, not a refusal", () => {
  const parsed = parseCsv("Opening balance,3068.57,\nCard payment,-45.00,2026-11-02", {
    date: 2,
    amount: 1,
    description: 0,
  });
  assert.equal(parsed.lines.length, 1, "only the genuine transaction parses");
  assert.equal(parsed.lines[0]!.description, "Card payment");
  assert.deepEqual(parsed.skipped, [
    { line: 1, code: "csv_balance_row", dateCell: "", amount: "3068.5700", balanceRole: "opening" },
  ]);
});

test("CSV still refuses a dateless transaction-looking row that is no balance", () => {
  assert.throws(
    () => parseCsv("Date,Amount,Description\n,45.00,Card payment", MAPPING),
    /looks like a transaction/,
  );
});

test("balance-summary rows are a lead word plus at most an amount", () => {
  const summaries = [
    "Opening 1,914.90",
    "Opening balance",
    "Opening balance 3,068.57",
    "Previous balance",
    "Balance b/f",
    "Closing 2,000.00",
    "opening",
    "  OPENING BALANCE  ",
  ];
  for (const description of summaries) {
    assert.equal(isBalanceSummaryRow(description), true, description);
  }
  const genuine = [
    "Store purchase",
    "Card charge",
    "Open invoice 123",
    "Opening deposit from client",
    "Previous month adjustment",
    "Final payment to vendor",
    "New equipment purchase",
    "Closing costs",
    "Monthly balance fee",
    "",
    null,
  ];
  for (const description of genuine) {
    assert.equal(isBalanceSummaryRow(description), false, String(description));
  }
});

const ofxDoc = (trns: string) =>
  [
    "OFXHEADER:100",
    "DATA:OFXSGML",
    "VERSION:102",
    "SECURITY:NONE",
    "ENCODING:USASCII",
    "CHARSET:1252",
    "COMPRESSION:NONE",
    "OLDFILEUID:NONE",
    "NEWFILEUID:NONE",
    "",
    `<OFX><CURDEF>CAD<STMTRS><BANKACCTFROM><ACCTID>123</ACCTID></BANKACCTFROM>${trns}</STMTRS></OFX>`,
  ].join("\r\n");

test("OFX tags a balance-summary pseudo-transaction", () => {
  const parsed = parseOfx(
    ofxDoc(
      "<STMTTRN><DTPOSTED>20261101</DTPOSTED><TRNAMT>3068.57</TRNAMT><NAME>Opening balance</NAME><FITID>bal-1</FITID></STMTTRN>" +
        "<STMTTRN><DTPOSTED>20261102</DTPOSTED><TRNAMT>-45.00</TRNAMT><NAME>Vendor</NAME><FITID>2</FITID></STMTTRN>",
    ),
  );
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[0]!.balanceHint, "opening");
  assert.equal(parsed.lines[1]!.balanceHint, null);
});

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

async function postReceipt(org: ScratchOrg, actorId: string, amount: string): Promise<string> {
  return db.transaction(async (tx) => {
    const entryId = randomUUID();
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`RCPT-${entryId.slice(0, 8)}`}, ${org.date}, ${org.periodId},
         'Receipt', 'draft', 'manual', ${actorId}, ${actorId})
    `);
    const offsetAmount = `-${amount}`;
    const [line] = (await tx.execute<{ id: string }>(sql`
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, subsidiary_id,
         amount, currency, txn_amount, fx_rate, memo)
      values
        (${randomUUID()}, ${org.orgId}, ${entryId}, 1,
         ${org.accounts.bank}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, 1, 'Receipt'),
        (${randomUUID()}, ${org.orgId}, ${entryId}, 2,
         ${org.accounts.adjustment}, ${org.subsidiaryId}, ${offsetAmount}, 'CAD', ${offsetAmount}, 1, 'Receipt')
      returning id
    `)).rows;
    await tx.execute(sql`
      update journal_entries
         set status = 'posted', posted_by = ${actorId}, updated_by = ${actorId}
       where id = ${entryId} and org_id = ${org.orgId}
    `);
    return line!.id;
  });
}

test(
  "an opening-balance row is offered as a balance and never blocks sign-off",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      // An informational "Opening balance 3,068.57" CSV row
      // must not become a statement transaction with no GL counterpart.
      const preview = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          lines: [
            { postedOn: org.date, amount: "3068.57", description: "Opening balance", bankTransactionId: "opening" },
            { postedOn: org.date, amount: "100.00", description: "Client receipt", bankTransactionId: "receipt" },
          ],
          dryRun: true,
        },
        ctx,
      );
      assert.equal(preview.imported, 1, "only the genuine transaction previews");
      assert.deepEqual(
        preview.balanceCandidates.map((c) => ({ amount: c.amount, role: c.role })),
        [{ amount: "3068.5700", role: "opening" }],
      );
      assert.equal(preview.lines.length, 1);

      const journal = await postReceipt(org, actor, "100.00");
      const imported = await importCsv(
        {
          accountId: org.accounts.bank,
          source: "csv" as const,
          statementDate: org.date,
          currency: "CAD",
          openingBalance: "3068.57",
          lines: [
            { postedOn: org.date, amount: "3068.57", description: "Opening balance", bankTransactionId: "opening" },
            { postedOn: org.date, amount: "100.00", description: "Client receipt", bankTransactionId: "receipt" },
          ],
        },
        ctx,
      );
      const stored = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from bank_statement_lines
         where org_id = ${org.orgId} and statement_id = ${imported.statementId!}
      `)).rows[0]!.n;
      assert.equal(stored, 1, "the balance row is never written as a transaction");
      assert.equal(imported.balanceCandidates.length, 1);

      const [receipt] = (await db.execute<{ id: string }>(sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and statement_id = ${imported.statementId!}
      `)).rows.map((row) => row.id);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "100.00" },
        ctx,
      );
      const totals = await createMatch(
        { reconciliationId: recon.id, statementLineIds: [receipt!], journalLineIds: [journal!] },
        ctx,
      );
      assert.equal(totals.difference, "0.0000");
      await markReconciled(recon.id, ctx);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
