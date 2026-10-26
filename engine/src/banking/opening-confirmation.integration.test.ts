import { before as initializeNativeComposition } from "node:test";
initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});
import { createWorkOperator } from "../testing/manufacturing.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  autoMatch,
  confirmOpeningBalance,
  createGlClearingGroup,
  createMatch,
  importStatement,
  markReconciled,
  openingPosition,
  reconciliationTotals,
  startReconciliation,
} from "./banking.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

// A first reconciliation from a balance-less CSV: fourteen statement lines
// with no imported opening or closing balance, an opening journal entry on
// the account that predates every bank line, and a hand-typed statement
// ending balance. The opening has no bank line by nature, so zero-sum GL
// clearing must refuse it and only an explicit, audited opening
// confirmation carries it into the session.
const OPENING_AMOUNT = "63412.55";
const OPENING_DATE = "2026-07-01";
const PERIOD_AMOUNTS = [
  "500.00",
  "500.00",
  "500.00",
  "500.00",
  "500.00",
  "500.00",
  "500.00",
  "500.00",
  "500.00",
  "500.00",
  "-100.00",
  "-150.00",
  "-124.09",
  "-100.00",
];
const CLOSING_TOTAL = "67938.46";
const FIRST_LINE_DATE = "2026-07-02";
const CONFIRM_REASON = "Opening balance from the prior-year close, confirmed to the bank records";

async function postBankJournal(
  org: ScratchOrg,
  actorId: string,
  bankAmounts: readonly string[],
  label: string,
  postingDate: string,
): Promise<string[]> {
  const negate = (amount: string) => (amount.startsWith("-") ? amount.slice(1) : `-${amount}`);
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
           ${org.subsidiaryId}, ${negate(amount)}, 'CAD',
           ${negate(amount)}, 1, ${label})
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

async function setupFirstRecon(org: ScratchOrg, actor: string) {
  const ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };
  await db.execute(sql`
    update accounts
       set reconcilable = true, currency_restriction = 'CAD'
     where id = ${org.accounts.bank} and org_id = ${org.orgId}
  `);
  const openingLines = await postBankJournal(org, actor, [OPENING_AMOUNT], "opening", OPENING_DATE);
  const lineDates = PERIOD_AMOUNTS.map(
    (_, index) => `2026-07-${String(2 + index).padStart(2, "0")}`,
  );
  const periodLineIds: string[] = [];
  for (let index = 0; index < PERIOD_AMOUNTS.length; index += 1) {
    const ids = await postBankJournal(
      org,
      actor,
      [PERIOD_AMOUNTS[index]!],
      `period-${index}`,
      lineDates[index]!,
    );
    periodLineIds.push(ids[0]!);
  }
  await importStatement(
    {
      accountId: org.accounts.bank,
      source: "manual",
      currency: "CAD",
      statementDate: org.date,
      lines: PERIOD_AMOUNTS.map((amount, index) => ({
        postedOn: lineDates[index]!,
        amount,
        description: `CSV line ${index + 1}`,
        bankTransactionId: `balance-less-csv-line-${index + 1}`,
      })),
    },
    ctx,
  );
  const recon = await startReconciliation(
    { accountId: org.accounts.bank, throughDate: org.date, statementBalance: CLOSING_TOTAL },
    ctx,
  );
  return { ctx, recon, openingLines, periodLineIds };
}

test(
  "a first reconciliation from a balance-less statement confirms its opening into sign-off",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createWorkOperator(org.orgId, "Bank reviewer", ["banking.reconcile"]);
      const { ctx, recon, openingLines } = await setupFirstRecon(org, actor);

      const position = (await openingPosition(recon.id, ctx))!;
      assert.equal(position.isFirst, true);
      assert.equal(position.statementOpening, null);
      assert.equal(position.coverageStart, FIRST_LINE_DATE);
      assert.equal(position.bookBalance, "63412.5500");
      assert.equal(position.confirmation, null);
      assert.equal(position.carryApplies, false);

      const matched = await autoMatch(recon.id, ctx);
      assert.equal(matched.matched, 14);
      assert.deepEqual(await reconciliationTotals(recon.id, ctx), {
        statementBalance: "67938.4600",
        clearedBalance: "4525.9100",
        difference: "63412.5500",
        matchedStatementLines: 14,
        unmatchedStatementLines: 0,
        matchedJournalLines: 14,
      });

      // The opening journal entry has no bank line by nature: zero-sum GL
      // clearing must refuse the single line, and the refusal is the
      // correct verdict — not a second way to clear an opening.
      await assert.rejects(
        createGlClearingGroup({ reconciliationId: recon.id, journalLineIds: openingLines }, ctx),
        /not zero/,
      );

      const totals = await confirmOpeningBalance(
        recon.id,
        { openingBalance: OPENING_AMOUNT, reason: CONFIRM_REASON },
        ctx,
      );
      assert.equal(totals.difference, "0.0000");
      assert.equal(totals.clearedBalance, "67938.4600");
      const confirmed = (await openingPosition(recon.id, ctx))!;
      assert.equal(confirmed.carryApplies, true);
      assert.equal(confirmed.carryStart, FIRST_LINE_DATE);
      assert.equal(confirmed.confirmation?.amount, "63412.5500");
      assert.equal(confirmed.confirmation?.reason, CONFIRM_REASON);
      const confirmAudit = (
        await db.execute<{ changes: { operation: string; reason: string; bookBalance: string } }>(
          sql`
        select changes from audit_log
         where org_id = ${org.orgId} and table_name = 'reconciliations' and row_id = ${recon.id}
           and action = 'update' and changes->>'operation' = 'confirm_opening'
      `,
          "objects",
        )
      )[0]!.changes;
      assert.equal(confirmAudit.operation, "confirm_opening");
      assert.equal(confirmAudit.reason, CONFIRM_REASON);
      assert.equal(confirmAudit.bookBalance, "63412.5500");

      assert.deepEqual(await markReconciled(recon.id, ctx), {
        status: "signed_off",
        journalLinesReconciled: 14,
      });
      const signoff = (
        await db.execute<{
          changes: { openingCarriedForward: string; openingCarryStartDate: string };
        }>(
          sql`
        select changes from audit_log
         where org_id = ${org.orgId} and table_name = 'reconciliations' and row_id = ${recon.id}
           and action = 'approve'
      `,
          "objects",
        )
      )[0]!.changes;
      assert.equal(signoff.openingCarriedForward, "63412.5500");
      assert.equal(signoff.openingCarryStartDate, FIRST_LINE_DATE);

      // The confirmed opening chains into the next session exactly like a
      // proven import opening: the carried journal stays stamped out of the
      // unreconciled pool and the second session balances on the new lines.
      const carriedStillOpen = (
        await db.execute<{ count: number }>(
          sql`
        select count(*)::int as count
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
         where jl.org_id = ${org.orgId} and jl.account_id = ${org.accounts.bank}
           and jl.reconciliation_id is null and je.posting_date < ${FIRST_LINE_DATE}
      `,
          "objects",
        )
      )[0]!.count;
      assert.equal(carriedStillOpen, 1);
      const period2 = await postBankJournal(org, actor, ["20"], "period-2", "2026-07-20");
      await importStatement(
        {
          accountId: org.accounts.bank,
          source: "manual",
          currency: "CAD",
          statementDate: "2026-07-20",
          lines: [
            {
              postedOn: "2026-07-20",
              amount: "20",
              description: "Second deposit",
              bankTransactionId: "confirmed-opening-second-deposit",
            },
          ],
        },
        ctx,
      );
      const statement2Id = (
        await db.execute<{ id: string }>(
          sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and bank_transaction_id = 'confirmed-opening-second-deposit'
      `,
          "objects",
        )
      )[0]!.id;
      const recon2 = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: "2026-07-20", statementBalance: "67958.46" },
        ctx,
      );
      await createMatch(
        { reconciliationId: recon2.id, statementLineIds: [statement2Id], journalLineIds: period2 },
        ctx,
      );
      assert.deepEqual(await reconciliationTotals(recon2.id, ctx), {
        statementBalance: "67958.4600",
        clearedBalance: "67958.4600",
        difference: "0.0000",
        matchedStatementLines: 1,
        unmatchedStatementLines: 0,
        matchedJournalLines: 1,
      });
      assert.deepEqual(await markReconciled(recon2.id, ctx), {
        status: "signed_off",
        journalLinesReconciled: 1,
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "opening confirmation refuses anything the ledger does not prove",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createWorkOperator(org.orgId, "Bank reviewer", ["banking.reconcile"]);
      const { ctx, recon } = await setupFirstRecon(org, actor);

      await assert.rejects(
        confirmOpeningBalance(
          recon.id,
          { openingBalance: "63000.00", reason: CONFIRM_REASON },
          ctx,
        ),
        /does not match the book balance carried in \(63412\.5500 through 2026-07-02\)/,
      );
      await assert.rejects(
        confirmOpeningBalance(recon.id, { openingBalance: OPENING_AMOUNT, reason: "ok" }, ctx),
        /between 5 and 500 characters/,
      );
      await assert.rejects(
        confirmOpeningBalance(recon.id, { openingBalance: "0", reason: CONFIRM_REASON }, ctx),
        /carries nothing/,
      );
      assert.equal((await openingPosition(recon.id, ctx))?.carryApplies, false);

      await confirmOpeningBalance(
        recon.id,
        { openingBalance: OPENING_AMOUNT, reason: CONFIRM_REASON },
        ctx,
      );
      // A ledger that moves underneath the confirmation fails closed: the
      // late pre-coverage posting resurfaces the opening as unproven.
      await postBankJournal(org, actor, ["100"], "late-opening", OPENING_DATE);
      assert.equal((await openingPosition(recon.id, ctx))?.carryApplies, false);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "opening confirmation is only for the first reconciliation",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    // Prove the first session the imported way so a signed-off session
    // exists to chain from: with an import opening the confirmation has
    // no business.
    const org = await createScratchOrg();
    try {
      const actor = await createWorkOperator(org.orgId, "Bank reviewer", ["banking.reconcile"]);
      const ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };
      await db.execute(sql`
        update accounts
           set reconcilable = true, currency_restriction = 'CAD'
         where id = ${org.accounts.bank} and org_id = ${org.orgId}
      `);
      await postBankJournal(org, actor, ["100"], "opening", "2026-07-01");
      const period = await postBankJournal(org, actor, ["30"], "period", org.date);
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
              bankTransactionId: "confirm-gated-period-deposit",
            },
          ],
        },
        ctx,
      );
      const lineId = (
        await db.execute<{ id: string }>(
          sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and bank_transaction_id = 'confirm-gated-period-deposit'
      `,
          "objects",
        )
      )[0]!.id;
      const first = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: org.date, statementBalance: "130" },
        ctx,
      );
      await createMatch(
        { reconciliationId: first.id, statementLineIds: [lineId], journalLineIds: period },
        ctx,
      );
      await markReconciled(first.id, ctx);
      await assert.rejects(
        confirmOpeningBalance(first.id, { openingBalance: "100", reason: CONFIRM_REASON }, ctx),
        /already signed off/,
      );
      const second = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: "2026-07-20", statementBalance: "130" },
        ctx,
      );
      await assert.rejects(
        confirmOpeningBalance(second.id, { openingBalance: "100", reason: CONFIRM_REASON }, ctx),
        /Only the first reconciliation of an account confirms an opening balance/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
