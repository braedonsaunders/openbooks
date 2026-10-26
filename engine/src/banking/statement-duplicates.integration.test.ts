import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  BankingError,
  createMatch,
  excludeStatementLine,
  importStatement,
  listSignOffBlockers,
  markReconciled,
  startReconciliation,
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

/** Post a balanced bank-side journal for one amount and return its bank line id. */
async function postBankJournal(
  org: ScratchOrg,
  actorId: string,
  amount: string,
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
         ${`DUP-${label}-${entryId.slice(0, 8)}`}, ${org.date}, ${org.periodId},
         ${`Duplicate review ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
    `);
    const bankLineId = randomUUID();
    await tx.execute(sql`
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, subsidiary_id,
         amount, currency, txn_amount, fx_rate, memo)
      values
        (${bankLineId}, ${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${org.subsidiaryId},
         ${amount}, 'CAD', ${amount}, 1, ${label})
    `);
    const offsetAmount = fromUnits(-toUnits(amount));
    await tx.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id,
         amount, currency, txn_amount, fx_rate, memo)
      values
        (${org.orgId}, ${entryId}, 2, ${org.accounts.adjustment}, ${org.subsidiaryId},
         ${offsetAmount}, 'CAD', ${offsetAmount}, 1, ${label})
    `);
    await tx.execute(sql`
      update journal_entries
         set status = 'posted', posted_by = ${actorId}, updated_by = ${actorId}
       where id = ${entryId} and org_id = ${org.orgId}
    `);
    return bankLineId;
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

async function lineIdByContent(
  orgId: string,
  statementId: string,
  postedOn: string,
  amount: string,
  description: string,
): Promise<string> {
  const row = (
    await db.execute<{ id: string }>(
      sql`
    select id from bank_statement_lines
     where org_id = ${orgId} and statement_id = ${statementId}
       and posted_on = ${postedOn} and amount = ${amount} and description = ${description}
  `,
      "objects",
    )
  )[0];
  assert.ok(row, `imported line ${postedOn} ${amount} ${description} must exist`);
  return row.id;
}

async function statementAudit(orgId: string, statementId: string) {
  return (
    await db.execute<{
      changes: {
        possibleDuplicatesExcluded?: { description: string; possibleDuplicateOf: string }[];
      };
    }>(
      sql`
    select changes from audit_log
     where org_id = ${orgId} and table_name = 'bank_statements' and row_id = ${statementId} and action = 'insert'
  `,
      "objects",
    )
  )[0]!.changes;
}

test(
  "possible duplicates are held out of the default import and import only on explicit opt-in",
  { skip: !DB },
  async () => {
    const { org, ctx } = await setup();
    try {
      const base = {
        accountId: org.accounts.bank,
        source: "manual" as const,
        statementDate: org.date,
        currency: "CAD",
      };
      const first = await importStatement(
        {
          ...base,
          lines: [
            { postedOn: org.date, amount: "-5.0000", description: "COFFEE SHOP" },
            { postedOn: org.date, amount: "100.0000", description: "PAYROLL" },
          ],
        },
        ctx,
      );
      assert.equal(first.imported, 2);
      const earlierCoffee = await lineIdByContent(
        org.orgId,
        first.statementId!,
        org.date,
        "-5.0000",
        "COFFEE SHOP",
      );

      // A later file repeats the coffee (re-keyed description) and adds a refund.
      const overlapping = {
        ...base,
        lines: [
          { postedOn: org.date, amount: "-5.0000", description: "coffee  shop" },
          { postedOn: org.date, amount: "20.0000", description: "REFUND" },
        ],
      };

      const preview = await importStatement({ ...overlapping, dryRun: true }, ctx);
      assert.equal(preview.statementId, null);
      assert.deepEqual(
        preview.lines.map((line) => line.description),
        ["REFUND"],
      );
      assert.equal(preview.possibleDuplicates, 1);
      assert.deepEqual(
        preview.possibleDuplicateLines.map((line) => line.possibleDuplicateOf),
        [earlierCoffee],
        "the preview names the held-out line and the line it duplicates",
      );

      // Default commit: the refund imports, the coffee is not written, and the
      // exclusion is recorded on the statement's audit row.
      const committed = await importStatement(overlapping, ctx);
      assert.ok(committed.statementId, "the non-duplicate line still imports");
      assert.equal(committed.imported, 1);
      assert.equal(committed.possibleDuplicates, 1);
      const written = await db.execute<{ description: string }>(
        sql`
        select description from bank_statement_lines
         where statement_id = ${committed.statementId} and org_id = ${org.orgId}
         order by line_number
      `,
        "objects",
      );
      assert.deepEqual(
        written.map((row) => row.description),
        ["REFUND"],
      );
      const committedAudit = await statementAudit(org.orgId, committed.statementId!);
      assert.deepEqual(
        committedAudit.possibleDuplicatesExcluded?.map((line) => ({
          description: line.description,
          possibleDuplicateOf: line.possibleDuplicateOf,
        })),
        [{ description: "coffee  shop", possibleDuplicateOf: earlierCoffee }],
        "the audit row records which line was held out and what it duplicates",
      );

      // Opt-in: the same coffee from its own file imports, flagged for review.
      const optedIn = await importStatement(
        {
          ...base,
          includePossibleDuplicates: true,
          lines: [{ postedOn: org.date, amount: "-5.0000", description: "COFFEE SHOP" }],
        },
        ctx,
      );
      assert.equal(optedIn.imported, 1);
      assert.equal(optedIn.possibleDuplicates, 1);
      const flagged = await db.execute<{
        possible_duplicate_of: string | null;
        bank_transaction_id: string | null;
      }>(
        sql`
        select possible_duplicate_of, bank_transaction_id from bank_statement_lines
         where statement_id = ${optedIn.statementId!} and org_id = ${org.orgId}
      `,
        "objects",
      );
      assert.equal(flagged.length, 1);
      assert.equal(flagged[0]!.possible_duplicate_of, earlierCoffee);
      assert.equal(
        flagged[0]!.bank_transaction_id,
        null,
        "an ID-less line stores no synthetic bank key",
      );
      const optedInAudit = await statementAudit(org.orgId, optedIn.statementId!);
      assert.equal(
        optedInAudit.possibleDuplicatesExcluded,
        undefined,
        "nothing was held out of an opted-in import",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a held duplicate left unmatched blocks sign-off with a label until it is excluded",
  { skip: !DB },
  async () => {
    const { org, actor, ctx } = await setup();
    try {
      const base = {
        accountId: org.accounts.bank,
        source: "manual" as const,
        statementDate: org.date,
        currency: "CAD",
      };
      const earlier = await importStatement(
        { ...base, lines: [{ postedOn: org.date, amount: "-7.0000", description: "COFFEE SHOP" }] },
        ctx,
      );
      const earlierId = await lineIdByContent(
        org.orgId,
        earlier.statementId!,
        org.date,
        "-7.0000",
        "COFFEE SHOP",
      );
      const statement = await importStatement(
        {
          ...base,
          includePossibleDuplicates: true,
          lines: [
            {
              postedOn: org.date,
              amount: "40.0000",
              description: "Client receipt",
              bankTransactionId: "receipt-40",
            },
            { postedOn: org.date, amount: "-7.0000", description: "COFFEE SHOP" },
          ],
        },
        ctx,
      );
      const receiptId = (
        await db.execute<{ id: string }>(
          sql`
        select id from bank_statement_lines
         where statement_id = ${statement.statementId!} and org_id = ${org.orgId} and bank_transaction_id = 'receipt-40'
      `,
          "objects",
        )
      )[0]!.id;
      const duplicateId = await lineIdByContent(
        org.orgId,
        statement.statementId!,
        org.date,
        "-7.0000",
        "COFFEE SHOP",
      );

      const receiptJournal = await postBankJournal(org, actor, "40.0000", "receipt");
      const coffeeJournal = await postBankJournal(org, actor, "-7.0000", "coffee");
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "33.00" },
        ctx,
      );
      await createMatch(
        {
          reconciliationId: recon.id,
          statementLineIds: [receiptId],
          journalLineIds: [receiptJournal],
        },
        ctx,
      );
      await createMatch(
        {
          reconciliationId: recon.id,
          statementLineIds: [earlierId],
          journalLineIds: [coffeeJournal],
        },
        ctx,
      );

      // The held duplicate is the only unmatched line through the cutoff, and
      // the blocker list names what it duplicates.
      const blocked = await listSignOffBlockers(recon.id, ctx);
      assert.equal(blocked.total, 1);
      const [blocker] = blocked.lines;
      assert.equal(blocker!.id, duplicateId);
      assert.equal(blocker!.possibleDuplicateOf, earlierId);
      assert.equal(blocker!.possibleDuplicateOfPostedOn, org.date);
      assert.equal(blocker!.possibleDuplicateOfAmount, "-7.0000");
      await assert.rejects(
        markReconciled(recon.id, ctx),
        (error: unknown) =>
          error instanceof BankingError &&
          /1 statement line\(s\) through the cutoff remain unmatched/.test(error.message),
      );

      // Excluding the unmatched duplicate inside the open cutoff is allowed and
      // clears the blocker; sign-off then proceeds.
      await excludeStatementLine(duplicateId, "Duplicate of the earlier COFFEE SHOP line", ctx);
      assert.equal((await listSignOffBlockers(recon.id, ctx)).total, 0);
      await markReconciled(recon.id, ctx);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
