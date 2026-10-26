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
  confirmOpeningBalance,
  createMatch,
  importStatement,
  markReconciled,
  openingPosition,
  reconciliationTotals,
  startReconciliation,
} from "./banking.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

// A first reconciliation on a credit-card (liability) account from a
// balance-less statement: the card owes 4,612.30 in GL terms (-4,612.30),
// the portal states it owing-positive, and the operator confirms the
// statement-facing 4,612.30. The confirmation must pair to GL terms and
// carry the session to sign-off exactly like the chequing path.
const CARD_OPENING_GL = "-4612.30";
const CARD_OPENING_STATEMENT = "4612.30";
const FIRST_LINE_DATE = "2026-10-02";
const CONFIRM_REASON = "Opening owing balance confirmed to the card portal statement";

async function createCardAccount(org: ScratchOrg): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, currency_restriction, required_dimensions, custom, subsidiary_include_children)
    values (${id}, ${org.orgId}, '2001', 'Corporate Card', 'liability_card', false, true, false, true, 'CAD', '[]'::jsonb, '{}'::jsonb, true)`);
  return id;
}

async function postCardJournal(
  org: ScratchOrg,
  actorId: string,
  cardId: string,
  glAmount: string,
  label: string,
  postingDate: string,
): Promise<string> {
  const negate = (amount: string) => (amount.startsWith("-") ? amount.slice(1) : `-${amount}`);
  return db.transaction(async (tx) => {
    const entryId = randomUUID();
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
         ${`CARD-${label}-${entryId.slice(0, 8)}`}, ${postingDate}, ${org.periodId},
         ${`Card ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
    `);
    const cardLineId = randomUUID();
    await tx.execute(sql`
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, subsidiary_id,
         amount, currency, txn_amount, fx_rate, memo)
      values
        (${cardLineId}, ${org.orgId}, ${entryId}, 1,
         ${cardId}, ${org.subsidiaryId}, ${glAmount}, 'CAD',
         ${glAmount}, 1, ${label})
    `);
    await tx.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id,
         amount, currency, txn_amount, fx_rate, memo)
      values
        (${org.orgId}, ${entryId}, 2, ${org.accounts.adjustment},
         ${org.subsidiaryId}, ${negate(glAmount)}, 'CAD',
         ${negate(glAmount)}, 1, ${label})
    `);
    await tx.execute(sql`
      update journal_entries
         set status = 'posted', posted_by = ${actorId}, updated_by = ${actorId}
       where id = ${entryId} and org_id = ${org.orgId}
    `);
    return cardLineId;
  });
}

async function setupCardRecon(org: ScratchOrg, actor: string) {
  const ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };
  const cardId = await createCardAccount(org);
  await postCardJournal(org, actor, cardId, CARD_OPENING_GL, "opening", "2026-10-01");
  const chargeId = await postCardJournal(org, actor, cardId, "-200.00", "charge", FIRST_LINE_DATE);
  const paymentId = await postCardJournal(org, actor, cardId, "500.00", "payment", "2026-10-03");
  await importStatement(
    {
      accountId: cardId,
      source: "manual",
      currency: "CAD",
      statementDate: "2026-10-03",
      lines: [
        {
          postedOn: FIRST_LINE_DATE,
          amount: "200.00",
          description: "Card charge",
          bankTransactionId: "card-line-charge",
        },
        {
          postedOn: "2026-10-03",
          amount: "-500.00",
          description: "Card payment",
          bankTransactionId: "card-line-payment",
        },
      ],
    },
    ctx,
  );
  const recon = await startReconciliation(
    { accountId: cardId, throughDate: "2026-10-03", statementBalance: "4312.30" },
    ctx,
  );
  return { ctx, cardId, recon, chargeId, paymentId };
}

async function statementLineIds(orgId: string, cardId: string): Promise<string[]> {
  return (
    await db.execute<{ id: string }>(
      sql`
    select id from bank_statement_lines
     where org_id = ${orgId} and account_id = ${cardId}
     order by posted_on asc
  `,
      "objects",
    )
  ).map((row) => row.id);
}

test(
  "a liability card's first reconciliation confirms its statement-facing opening into sign-off",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createWorkOperator(org.orgId, "Bank reviewer", ["banking.reconcile"]);
      const { ctx, cardId, recon, chargeId, paymentId } = await setupCardRecon(org, actor);

      const position = await openingPosition(recon.id, ctx);
      assert.equal(position.isFirst, true);
      assert.equal(position.statementOpening, null);
      assert.equal(position.bookBalance, "-4612.3000");

      await createMatch(
        {
          reconciliationId: recon.id,
          statementLineIds: await statementLineIds(org.orgId, cardId),
          journalLineIds: [chargeId, paymentId],
        },
        ctx,
      );

      const totals = await confirmOpeningBalance(
        recon.id,
        { openingBalance: CARD_OPENING_STATEMENT, reason: CONFIRM_REASON },
        ctx,
      );
      assert.equal(totals.difference, "0.0000");

      const confirmed = await openingPosition(recon.id, ctx);
      assert.equal(confirmed.carryApplies, true);
      assert.equal(confirmed.confirmation?.amount, "-4612.3000");

      assert.deepEqual(await reconciliationTotals(recon.id, ctx), {
        statementBalance: "4312.3000",
        clearedBalance: "4312.3000",
        difference: "0.0000",
        matchedStatementLines: 2,
        unmatchedStatementLines: 0,
        matchedJournalLines: 2,
      });
      assert.deepEqual(await markReconciled(recon.id, ctx), {
        status: "signed_off",
        journalLinesReconciled: 2,
      });

      // The GL-signed carry chains into the next session: new lines balance
      // on the carried opening exactly like the chequing path.
      const period2 = await postCardJournal(org, actor, cardId, "-20.00", "period-2", "2026-10-20");
      await importStatement(
        {
          accountId: cardId,
          source: "manual",
          currency: "CAD",
          statementDate: "2026-10-20",
          lines: [
            {
              postedOn: "2026-10-20",
              amount: "20.00",
              description: "Second charge",
              bankTransactionId: "card-second-charge",
            },
          ],
        },
        ctx,
      );
      const statement2Id = (
        await db.execute<{ id: string }>(
          sql`
        select id from bank_statement_lines
         where org_id = ${org.orgId} and bank_transaction_id = 'card-second-charge'
      `,
          "objects",
        )
      )[0]!.id;
      const recon2 = await startReconciliation(
        { accountId: cardId, throughDate: "2026-10-20", statementBalance: "4332.30" },
        ctx,
      );
      await createMatch(
        {
          reconciliationId: recon2.id,
          statementLineIds: [statement2Id],
          journalLineIds: [period2],
        },
        ctx,
      );
      assert.deepEqual(await reconciliationTotals(recon2.id, ctx), {
        statementBalance: "4332.3000",
        clearedBalance: "4332.3000",
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
  "a liability card also confirms its GL-signed opening into the same carry",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createWorkOperator(org.orgId, "Bank reviewer", ["banking.reconcile"]);
      const { ctx, cardId, recon, chargeId, paymentId } = await setupCardRecon(org, actor);
      await createMatch(
        {
          reconciliationId: recon.id,
          statementLineIds: await statementLineIds(org.orgId, cardId),
          journalLineIds: [chargeId, paymentId],
        },
        ctx,
      );
      const totals = await confirmOpeningBalance(
        recon.id,
        { openingBalance: CARD_OPENING_GL, reason: CONFIRM_REASON },
        ctx,
      );
      assert.equal(totals.difference, "0.0000");
      const confirmed = await openingPosition(recon.id, ctx);
      assert.equal(confirmed.carryApplies, true);
      assert.equal(confirmed.confirmation?.amount, "-4612.3000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a liability card refuses an unproven opening naming the book balance",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createWorkOperator(org.orgId, "Bank reviewer", ["banking.reconcile"]);
      const { ctx, recon } = await setupCardRecon(org, actor);
      await assert.rejects(
        confirmOpeningBalance(recon.id, { openingBalance: "4600.00", reason: CONFIRM_REASON }, ctx),
        /does not match the book balance carried in \(-4612\.3000 through 2026-10-02\)/,
      );
      await assert.rejects(
        confirmOpeningBalance(
          recon.id,
          { openingBalance: CARD_OPENING_STATEMENT, reason: "ok" },
          ctx,
        ),
        /between 5 and 500 characters/,
      );
      await assert.rejects(
        confirmOpeningBalance(recon.id, { openingBalance: "0", reason: CONFIRM_REASON }, ctx),
        /carries nothing/,
      );
      assert.equal((await openingPosition(recon.id, ctx))?.carryApplies, false);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
