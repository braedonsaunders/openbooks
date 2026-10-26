import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { runPostDocumentEffects } from "../ledger/posting-dispatch.ts";
import { completeRequestedDocumentVoid, requestDocumentVoid } from "../ledger/document-void.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  applyStandaloneCredits,
  creditSettlementState,
  unapplyCreditSettlement,
  UNAPPLIED_PAYMENT_APPLICATION_REFERENCE,
} from "./credit-settlement.ts";
import { createPaymentDocument, updateDraftPayment } from "./payment-documents.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import { paymentBookId } from "./payment-accounts.ts";
import { creditItemsForParty, openItemsForParty } from "./payment-queries.ts";
import { sameCurrencyAllocation } from "./settlement-policy.ts";

// A payment's unapplied cash — a receipt's on-account credit, a vendor
// payment's prepayment — applied later to the party's other open documents
// through the standalone application path, against real Postgres.
const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function postDocumentOf(
  org: ScratchOrg,
  userId: string,
  kind: "customer_invoice" | "vendor_bill",
  amount: string,
): Promise<{ id: string; lineId: string }> {
  const id = randomUUID();
  const invoice = kind === "customer_invoice";
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, ${kind}, 'draft', ${`${invoice ? "INV" : "BILL"}-${id.slice(0, 8)}`}, ${org.subsidiaryId},
            ${invoice ? org.customerId : org.vendorId}, ${org.date}, 'CAD', '1', ${amount}, '0', ${amount}, ${userId})`);
  await db.execute(sql`
    insert into document_lines (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${id}, 1, ${invoice ? org.accounts.revenue : org.accounts.adjustment}, '1', ${amount}, ${amount}, '0', '0')`);
  await db.execute(
    sql`update documents set status = 'approved' where id = ${id} and org_id = ${org.orgId}`,
  );
  await postDocument(id, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
  const lineId = (
    await db.execute<{ id: string }>(
      sql`
    select jl.id from journal_lines jl join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
     where jl.org_id = ${org.orgId} and je.source_document_id = ${id} and jl.is_open_item`,
      "objects",
    )
  )[0]!.id;
  return { id, lineId };
}

/** A posted payment applying `applied` and keeping `onAccount` unapplied; returns the payment and its open-item line. */
async function postPayment(
  org: ScratchOrg,
  userId: string,
  kind: "customer_payment" | "vendor_payment",
  allocations: ReturnType<typeof sameCurrencyAllocation>[],
  onAccountAmount: string,
) {
  const payment = await createPaymentDocument({
    orgId: org.orgId,
    kind,
    createdBy: userId,
    allowedSubsidiaryIds: null,
    partyId: kind === "customer_payment" ? org.customerId : org.vendorId,
    bankAccountId: org.accounts.bank,
    subsidiaryId: org.subsidiaryId,
    documentDate: org.date,
    currency: "CAD",
  });
  await updateDraftPayment(payment.id, { allocations, onAccountAmount }, userId, org.orgId, {
    allowedSubsidiaryIds: null,
  });
  await db.execute(
    sql`update documents set status = 'approved', updated_at = now() where id = ${payment.id} and org_id = ${org.orgId}`,
  );
  const { entryId } = await withOrgTransaction(org.orgId, () =>
    postPaymentWithApplications(payment.id, allocations, userId, "ui", { deferEffects: true }),
  );
  const lineId = (
    await db.execute<{ id: string }>(
      sql`
    select id from journal_lines where org_id = ${org.orgId} and entry_id = ${entryId} and is_open_item`,
      "objects",
    )
  )[0]!.id;
  return { id: payment.id, lineId };
}

async function openOf(org: ScratchOrg, side: "ar" | "ap", lineId: string): Promise<string> {
  const items = await openItemsForParty(
    side === "ar" ? org.customerId : org.vendorId,
    side,
    org.orgId,
  );
  return items.find((item) => item.lineId === lineId)?.transactionOpen ?? "0";
}

test(
  "a receipt's unapplied credit is listed, applied to another invoice, and released, with its own evidence",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(async () => {
        const userId = await createScratchUser(org.orgId, "Collections", "admin");
        const first = await postDocumentOf(org, userId, "customer_invoice", "100.00");
        const second = await postDocumentOf(org, userId, "customer_invoice", "80.00");
        const receipt = await postPayment(
          org,
          userId,
          "customer_payment",
          [sameCurrencyAllocation(first.lineId, "100")],
          "50",
        );

        assert.ok(
          !(await creditItemsForParty(org.customerId, "ar", org.orgId)).some(
            (item) => item.lineId === receipt.lineId,
          ),
          "the payment-drawer credit list stays credit memos only",
        );
        const listed = (
          await creditItemsForParty(org.customerId, "ar", org.orgId, null, {
            includeUnappliedPayments: true,
          })
        ).find((item) => item.lineId === receipt.lineId);
        assert.ok(listed, "the receipt's unapplied cash is listed as a credit");
        assert.equal(listed.transactionOpen, "50.0000");

        const settled = await applyStandaloneCredits(
          org.orgId,
          userId,
          {
            partyId: org.customerId,
            side: "ar",
            appliedOn: org.date,
            idempotencyKey: randomUUID(),
            credits: [
              {
                fromLineId: receipt.lineId,
                toLineId: second.lineId,
                amount: "50.0000",
                sourceDocumentId: receipt.id,
              },
            ],
          },
          null,
        );
        assert.equal(settled.amount, "50.0000");
        assert.equal(await openOf(org, "ar", second.lineId), "30.0000");
        const application = (
          await db.execute<{ reference: string; source: string }>(
            sql`
        select settlement_rate_reference as reference, settlement_rate_source as source from applications where org_id = ${org.orgId} and id = ${settled.applicationIds[0]}`,
            "objects",
          )
        )[0]!;
        assert.deepEqual(application, {
          reference: UNAPPLIED_PAYMENT_APPLICATION_REFERENCE,
          source: "same_currency",
        });
        const audit = (
          await db.execute<{ from_payment: boolean }>(
            sql`
        select (changes->'after'->>'fromUnappliedPayment')::boolean as from_payment from audit_log
         where org_id = ${org.orgId} and table_name = 'applications' and row_id = ${settled.applicationIds[0]} and action = 'insert'`,
            "objects",
          )
        )[0]!;
        assert.equal(audit.from_payment, true);

        const state = await creditSettlementState(org.orgId, receipt.id, null);
        assert.equal(state?.open, "0.0000");
        assert.deepEqual(
          state?.settlements.map((row) => row.amount),
          ["50.0000"],
          "only the later application is a settlement of the unapplied cash",
        );

        // The receipt's own posting-time application belongs to the receipt.
        const own = (
          await db.execute<{ id: string }>(
            sql`
        select a.id from applications a where a.org_id = ${org.orgId} and a.from_line_id = ${receipt.lineId} and a.to_line_id = ${first.lineId}`,
            "objects",
          )
        )[0]!;
        await assert.rejects(
          unapplyCreditSettlement(org.orgId, userId, own.id, null),
          (error: unknown) =>
            error instanceof PaymentError && /cash application/.test(error.message),
        );

        await unapplyCreditSettlement(org.orgId, userId, settled.applicationIds[0]!, null);
        assert.equal(await openOf(org, "ar", second.lineId), "80.0000");
        assert.equal((await creditSettlementState(org.orgId, receipt.id, null))?.open, "50.0000");
      });
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test("a vendor prepayment settles a later bill without new cash", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(async () => {
      const userId = await createScratchUser(org.orgId, "Payables", "admin");
      const prepayment = await postPayment(org, userId, "vendor_payment", [], "120");
      const bill = await postDocumentOf(org, userId, "vendor_bill", "100.00");
      await applyStandaloneCredits(
        org.orgId,
        userId,
        {
          partyId: org.vendorId,
          side: "ap",
          appliedOn: org.date,
          idempotencyKey: randomUUID(),
          credits: [
            {
              fromLineId: prepayment.lineId,
              toLineId: bill.lineId,
              amount: "100.0000",
              sourceDocumentId: prepayment.id,
            },
          ],
        },
        null,
      );
      assert.equal(await openOf(org, "ap", bill.lineId), "0");
      assert.equal((await creditSettlementState(org.orgId, prepayment.id, null))?.open, "20.0000");
      // Overdrawing the prepayment is refused by the open-balance checks.
      const another = await postDocumentOf(org, userId, "vendor_bill", "50.00");
      await assert.rejects(
        applyStandaloneCredits(
          org.orgId,
          userId,
          {
            partyId: org.vendorId,
            side: "ap",
            appliedOn: org.date,
            idempotencyKey: randomUUID(),
            credits: [
              {
                fromLineId: prepayment.lineId,
                toLineId: another.lineId,
                amount: "50.0000",
                sourceDocumentId: prepayment.id,
              },
            ],
          },
          null,
        ),
      );
      assert.equal(await openOf(org, "ap", another.lineId), "50.0000");
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test(
  "applying unapplied cash respects the period fence, and a payment carrying credits still takes only credit memos",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(async () => {
        const userId = await createScratchUser(org.orgId, "Collections", "admin");
        const invoice = await postDocumentOf(org, userId, "customer_invoice", "80.00");
        const receipt = await postPayment(org, userId, "customer_payment", [], "40");
        const bookId = await paymentBookId(org.orgId);
        await db.execute(sql`
        insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, locked_by)
        values (${org.orgId}, ${org.periodId}, ${bookId}, ${org.subsidiaryId}, 'ar', 'closed', now(), ${userId})`);
        await assert.rejects(
          applyStandaloneCredits(
            org.orgId,
            userId,
            {
              partyId: org.customerId,
              side: "ar",
              appliedOn: org.date,
              idempotencyKey: randomUUID(),
              credits: [
                {
                  fromLineId: receipt.lineId,
                  toLineId: invoice.lineId,
                  amount: "40.0000",
                  sourceDocumentId: receipt.id,
                },
              ],
            },
            null,
          ),
          /closed/i,
        );
        assert.equal(await openOf(org, "ar", invoice.lineId), "80.0000");
        await db.execute(
          sql`delete from period_locks where org_id = ${org.orgId} and period_id = ${org.periodId}`,
        );

        const draft = await createPaymentDocument({
          orgId: org.orgId,
          kind: "customer_payment",
          createdBy: userId,
          allowedSubsidiaryIds: null,
          partyId: org.customerId,
          bankAccountId: org.accounts.bank,
          subsidiaryId: org.subsidiaryId,
          documentDate: org.date,
          currency: "CAD",
        });
        await assert.rejects(
          updateDraftPayment(
            draft.id,
            {
              allocations: [sameCurrencyAllocation(invoice.lineId, "10")],
              creditAllocations: [
                {
                  fromLineId: receipt.lineId,
                  toLineId: invoice.lineId,
                  amount: "40.0000",
                  sourceDocumentId: receipt.id,
                },
              ],
            },
            userId,
            org.orgId,
            { allowedSubsidiaryIds: null },
          ),
          (error: unknown) =>
            error instanceof PaymentError && /customer_credit/.test(error.message),
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "two concurrent applications of the same unapplied cash cannot both settle it",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const fixture = await withBypassContext(async () => {
        const userId = await createScratchUser(org.orgId, "Collections", "admin");
        const a = await postDocumentOf(org, userId, "customer_invoice", "60.00");
        const b = await postDocumentOf(org, userId, "customer_invoice", "60.00");
        const receipt = await postPayment(org, userId, "customer_payment", [], "60");
        return { userId, a, b, receipt };
      });
      const apply = (target: string) =>
        withBypassContext(() =>
          applyStandaloneCredits(
            org.orgId,
            fixture.userId,
            {
              partyId: org.customerId,
              side: "ar",
              appliedOn: org.date,
              idempotencyKey: randomUUID(),
              credits: [
                {
                  fromLineId: fixture.receipt.lineId,
                  toLineId: target,
                  amount: "60.0000",
                  sourceDocumentId: fixture.receipt.id,
                },
              ],
            },
            null,
          ),
        );
      const outcomes = await Promise.allSettled([apply(fixture.a.lineId), apply(fixture.b.lineId)]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      const live = (
        await withBypassContext(() =>
          db.execute<{ n: number }>(
            sql`
      select count(*)::int as n from applications where org_id = ${org.orgId} and from_line_id = ${fixture.receipt.lineId} and unapplied_at is null`,
            "objects",
          ),
        )
      )[0]!.n;
      assert.equal(live, 1);
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "voiding a receipt releases the later applications of its unapplied cash with it",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(async () => {
        const userId = await createScratchUser(org.orgId, "Collections", "admin");
        const invoice = await postDocumentOf(org, userId, "customer_invoice", "70.00");
        const receipt = await postPayment(org, userId, "customer_payment", [], "70");
        await applyStandaloneCredits(
          org.orgId,
          userId,
          {
            partyId: org.customerId,
            side: "ar",
            appliedOn: org.date,
            idempotencyKey: randomUUID(),
            credits: [
              {
                fromLineId: receipt.lineId,
                toLineId: invoice.lineId,
                amount: "70.0000",
                sourceDocumentId: receipt.id,
              },
            ],
          },
          null,
        );
        assert.equal(await openOf(org, "ar", invoice.lineId), "0");
        await runPostDocumentEffects(receipt.id, "draft");
        const requested = await requestDocumentVoid({
          documentId: receipt.id,
          orgId: org.orgId,
          actorId: userId,
          reason: "deposit returned",
          reversalDate: org.date,
          source: "api",
        });
        assert.equal(requested.status, "voided");
        await completeRequestedDocumentVoid(receipt.id, org.orgId, null);
        assert.equal(
          await openOf(org, "ar", invoice.lineId),
          "70.0000",
          "the invoice reopens with the receipt",
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
