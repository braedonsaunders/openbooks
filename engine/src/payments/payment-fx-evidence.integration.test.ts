import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { PaymentError, PaymentRevisionConflictError } from "../payments-core/payment-errors.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { createPaymentDocument, updateDraftPayment } from "./payment-documents.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import { loadPaymentDocument, openItemsForParty } from "./payment-queries.ts";
import { sameCurrencyAllocation, type AllocationInput } from "./settlement-policy.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Settlement-rate evidence cases. Every scenario measures foreign-currency
 * payments from recorded document evidence only: no scenario inserts an
 * fx_rates row, and each asserts the tenant still has none.
 */
async function setupOrg() {
  const org = await createScratchOrg();
  const userId = await createScratchUser(org.orgId, "FX Tester", "admin");
  await db.execute(sql`
    update orgs set settings = settings || '{"features":{"banking":true,"multiCurrency":true}}'::jsonb
     where id = ${org.orgId}`);
  await db.execute(sql`
    insert into currencies (code, name, minor_units)
    values ('EUR', 'Euro', 2), ('USD', 'US Dollar', 2)
    on conflict (code) do nothing`);
  return { org, userId };
}

async function assertNoFxRates(orgId: string) {
  const rows = await db.execute<{ count: string }>(
    sql`
    select count(*)::text as count from fx_rates where org_id = ${orgId}`,
    "objects",
  );
  assert.equal(rows[0]!.count, "0", "no scenario may seed or invent an fx_rates row");
}

/** Post an invoice/bill carried at a stated document rate (never a rate row). */
async function seedPostedDocument(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  userId: string,
  input: {
    kind: "customer_invoice" | "vendor_bill";
    currency: string;
    amount: string;
    fxRate: string;
    subsidiaryId?: string;
  },
): Promise<string> {
  const id = randomUUID();
  const isInvoice = input.kind === "customer_invoice";
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, ${input.kind}, 'draft', ${`${isInvoice ? "INV" : "BILL"}-${randomUUID().slice(0, 8)}`},
            ${input.subsidiaryId ?? org.subsidiaryId}, ${isInvoice ? org.customerId : org.vendorId}, ${org.date},
            ${input.currency}, ${input.fxRate}, ${input.amount}, '0', ${input.amount}, ${userId})`);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${id}, 1, ${isInvoice ? org.accounts.revenue : org.accounts.adjustment},
            '1', ${input.amount}, ${input.amount}, '0', '0')`);
  await db.execute(
    sql`update documents set status = 'approved', updated_at = now() where id = ${id} and org_id = ${org.orgId}`,
  );
  await postDocument(id, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
  return id;
}

function explicitFx(rate: string, fromCurrency: string, toCurrency: string, rateDate: string) {
  return {
    rate,
    source: "Bank confirmation",
    reason: "Rate evidenced on the bank's settlement confirmation",
    fromCurrency,
    toCurrency,
    rateDate,
  };
}

async function draftPayment(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  userId: string,
  input: {
    kind: "customer_payment" | "vendor_payment";
    currency: string;
    allocations: AllocationInput[];
    explicitFx?: ReturnType<typeof explicitFx> | null;
    subsidiaryId?: string;
  },
): Promise<string> {
  const payment = await createPaymentDocument({
    orgId: org.orgId,
    kind: input.kind,
    createdBy: userId,
    allowedSubsidiaryIds: null,
    partyId: input.kind === "customer_payment" ? org.customerId : org.vendorId,
    bankAccountId: org.accounts.bank,
    documentDate: org.date,
    subsidiaryId: input.subsidiaryId ?? org.subsidiaryId,
    currency: input.currency,
  });
  await updateDraftPayment(
    payment.id,
    {
      allocations: input.allocations,
      ...(input.explicitFx !== undefined ? { explicitFx: input.explicitFx } : {}),
    },
    userId,
    org.orgId,
    { allowedSubsidiaryIds: null },
  );
  return payment.id;
}

async function postPayment(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  userId: string,
  paymentId: string,
  kind: "customer_payment" | "vendor_payment",
  allocations: AllocationInput[],
) {
  const submission = await submitAndReleaseIfUngated(kind, paymentId, userId);
  assert.equal(submission.gated, false);
  await postPaymentWithApplications(paymentId, allocations, userId, "api");
}

async function openItemFor(orgId: string, partyId: string, side: "ar" | "ap", documentId: string) {
  const items = await openItemsForParty(partyId, side, orgId);
  const item = items.find((candidate) => candidate.documentId === documentId);
  assert.ok(item, "the seeded document is an open item");
  return item;
}

async function paymentEntryLines(orgId: string, paymentId: string) {
  return await db.execute<{ name: string; amount: string; entry_id: string }>(
    sql`
    select a.name, jl.amount::text as amount, je.id as entry_id
      from documents d
      join journal_entries je on je.id = d.posted_entry_id and je.org_id = d.org_id
      join journal_lines jl on jl.entry_id = je.id and jl.org_id = je.org_id
      join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
     where d.org_id = ${orgId} and d.id = ${paymentId}
     order by a.name`,
    "objects",
  );
}

async function applicationsOf(orgId: string, paymentId: string) {
  return await db.execute<{
    amount: string;
    source_amount: string;
    settlement_rate: string;
    settlement_rate_source: string;
    fx_gain_loss_entry_id: string | null;
    unapplied_at: string | null;
  }>(
    sql`
    select a.amount::text as amount, a.source_amount::text as source_amount,
           a.settlement_rate::text as settlement_rate, a.settlement_rate_source,
           a.fx_gain_loss_entry_id, a.unapplied_at::text as unapplied_at
      from applications a
      join journal_lines jl on jl.id = a.from_line_id and jl.org_id = a.org_id
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
      join documents d on d.id = je.source_document_id and d.org_id = je.org_id
     where a.org_id = ${orgId} and d.id = ${paymentId}`,
    "objects",
  );
}

async function fxLinesOf(orgId: string, fxEntryId: string) {
  return await db.execute<{ name: string; amount: string }>(
    sql`
    select a.name, jl.amount::text as amount
      from journal_lines jl
      join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
     where jl.org_id = ${orgId} and jl.entry_id = ${fxEntryId}
     order by a.name`,
    "objects",
  );
}

async function storedEvidence(orgId: string, paymentId: string) {
  return (
    await db.execute<{
      fx_rate: string;
      document_fx_rate_evidence: { rate: string; toCurrency: string } | null;
      status: string;
    }>(
      sql`
    select fx_rate::text as fx_rate, document_fx_rate_evidence, status
      from documents where org_id = ${orgId} and id = ${paymentId}`,
      "objects",
    )
  )[0]!;
}

test(
  "a EUR 1000 receipt at a recorded 1.115 settles an invoice carried at 1.10 with a 15 gain",
  { skip: !DB },
  async () => {
    const { org, userId } = await setupOrg();
    try {
      const invoiceId = await seedPostedDocument(org, userId, {
        kind: "customer_invoice",
        currency: "EUR",
        amount: "1000",
        fxRate: "1.1",
      });
      const item = await openItemFor(org.orgId, org.customerId, "ar", invoiceId);
      const allocations = [sameCurrencyAllocation(item.lineId, "1000")];
      const receiptId = await draftPayment(org, userId, {
        kind: "customer_payment",
        currency: "EUR",
        allocations,
        explicitFx: explicitFx("1.115", "EUR", "CAD", org.date),
      });
      const stored = await storedEvidence(org.orgId, receiptId);
      assert.equal(stored.fx_rate, "1.1150000000");
      assert.equal(stored.document_fx_rate_evidence?.rate, "1.115");
      await postPayment(org, userId, receiptId, "customer_payment", allocations);

      const lines = new Map(
        (await paymentEntryLines(org.orgId, receiptId)).map((line) => [line.name, line.amount]),
      );
      assert.equal(
        lines.get("Cash"),
        "1115.0000",
        "bank is measured at the recorded settlement rate",
      );
      assert.equal(lines.get("Accounts Receivable"), "-1115.0000");
      const [application] = await applicationsOf(org.orgId, receiptId);
      assert.equal(application!.amount, "1100.0000", "AR relief is the invoice's carrying amount");
      assert.ok(application!.fx_gain_loss_entry_id);
      const fx = new Map(
        (await fxLinesOf(org.orgId, application!.fx_gain_loss_entry_id!)).map((line) => [
          line.name,
          line.amount,
        ]),
      );
      assert.equal(
        fx.get("Realized FX Gain or Loss"),
        "-15.0000",
        "the 15 difference is a realized gain",
      );
      assert.equal(fx.get("Accounts Receivable"), "15.0000", "net AR relief is exactly 1100");
      await assertNoFxRates(org.orgId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a partial EUR 600 receipt consumes 660 of carrying value, pays 669 cash and gains 9",
  { skip: !DB },
  async () => {
    const { org, userId } = await setupOrg();
    try {
      const invoiceId = await seedPostedDocument(org, userId, {
        kind: "customer_invoice",
        currency: "EUR",
        amount: "1000",
        fxRate: "1.1",
      });
      const item = await openItemFor(org.orgId, org.customerId, "ar", invoiceId);
      const allocations = [sameCurrencyAllocation(item.lineId, "600")];
      const receiptId = await draftPayment(org, userId, {
        kind: "customer_payment",
        currency: "EUR",
        allocations,
        explicitFx: explicitFx("1.115", "EUR", "CAD", org.date),
      });
      await postPayment(org, userId, receiptId, "customer_payment", allocations);

      const lines = new Map(
        (await paymentEntryLines(org.orgId, receiptId)).map((line) => [line.name, line.amount]),
      );
      assert.equal(lines.get("Cash"), "669.0000");
      const [application] = await applicationsOf(org.orgId, receiptId);
      assert.equal(application!.amount, "660.0000");
      const fx = new Map(
        (await fxLinesOf(org.orgId, application!.fx_gain_loss_entry_id!)).map((line) => [
          line.name,
          line.amount,
        ]),
      );
      assert.equal(fx.get("Realized FX Gain or Loss"), "-9.0000");
      const residual = await openItemFor(org.orgId, org.customerId, "ar", invoiceId);
      assert.equal(
        residual.transactionOpen,
        "400.0000",
        "EUR 400 stays open in transaction currency",
      );
      assert.equal(residual.open, "440.0000", "CAD 440 of carrying value stays open");
      await assertNoFxRates(org.orgId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a CAD 1000 bill paid at a recorded 0.745 against a 0.74 carrying rate loses 5 in a USD entity",
  { skip: !DB },
  async () => {
    const { org, userId } = await setupOrg();
    try {
      await db.execute(
        sql`update subsidiaries set base_currency = 'USD' where id = ${org.subsidiaryId} and org_id = ${org.orgId}`,
      );
      const billId = await seedPostedDocument(org, userId, {
        kind: "vendor_bill",
        currency: "CAD",
        amount: "1000",
        fxRate: "0.74",
      });
      const item = await openItemFor(org.orgId, org.vendorId, "ap", billId);
      const allocations = [sameCurrencyAllocation(item.lineId, "1000")];
      const paymentId = await draftPayment(org, userId, {
        kind: "vendor_payment",
        currency: "CAD",
        allocations,
        explicitFx: explicitFx("0.745", "CAD", "USD", org.date),
      });
      await postPayment(org, userId, paymentId, "vendor_payment", allocations);

      const lines = new Map(
        (await paymentEntryLines(org.orgId, paymentId)).map((line) => [line.name, line.amount]),
      );
      assert.equal(
        lines.get("Cash"),
        "-745.0000",
        "cash is measured at the recorded settlement rate",
      );
      const [application] = await applicationsOf(org.orgId, paymentId);
      assert.equal(
        application!.amount,
        "740.0000",
        "AP relief is the bill's carrying amount, leaving AP at zero",
      );
      const fx = new Map(
        (await fxLinesOf(org.orgId, application!.fx_gain_loss_entry_id!)).map((line) => [
          line.name,
          line.amount,
        ]),
      );
      assert.equal(
        fx.get("Realized FX Gain or Loss"),
        "5.0000",
        "the 5 difference is a realized loss",
      );
      await assertNoFxRates(org.orgId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "pair, date and entity mismatches refuse, recorded evidence freezes after draft, and a stale revision replays as a conflict",
  { skip: !DB },
  async () => {
    const { org, userId } = await setupOrg();
    try {
      const receiptId = (
        await createPaymentDocument({
          orgId: org.orgId,
          kind: "customer_payment",
          createdBy: userId,
          allowedSubsidiaryIds: null,
          partyId: org.customerId,
          bankAccountId: org.accounts.bank,
          documentDate: org.date,
          subsidiaryId: org.subsidiaryId,
          currency: "EUR",
        })
      ).id;
      await assert.rejects(
        () =>
          updateDraftPayment(
            receiptId,
            { explicitFx: explicitFx("1.115", "EUR", "CAD", "2026-07-14") },
            userId,
            org.orgId,
            { allowedSubsidiaryIds: null },
          ),
        (error: unknown) =>
          error instanceof PaymentError && /must be for 2026-07-15/.test(error.message),
      );
      await assert.rejects(
        () =>
          updateDraftPayment(
            receiptId,
            { explicitFx: explicitFx("1.115", "CAD", "EUR", org.date) },
            userId,
            org.orgId,
            { allowedSubsidiaryIds: null },
          ),
        (error: unknown) =>
          error instanceof PaymentError && /must convert EUR to CAD/.test(error.message),
      );
      await updateDraftPayment(
        receiptId,
        { explicitFx: explicitFx("1.115", "EUR", "CAD", org.date) },
        userId,
        org.orgId,
        { allowedSubsidiaryIds: null },
      );
      // Moving the posting date without a replacement rate refuses by identity.
      await assert.rejects(
        () =>
          updateDraftPayment(receiptId, { documentDate: "2026-07-16" }, userId, org.orgId, {
            allowedSubsidiaryIds: null,
          }),
        (error: unknown) =>
          error instanceof PaymentError && /previous posting date/.test(error.message),
      );
      // A save fenced on a superseded revision is a conflict, never an overwrite.
      const loaded = await loadPaymentDocument(receiptId, "customer_payment", org.orgId, null);
      const revision = String(loaded!.doc.updated_at);
      await updateDraftPayment(receiptId, { memo: "first save" }, userId, org.orgId, {
        allowedSubsidiaryIds: null,
        expectedRevision: revision,
      });
      await assert.rejects(
        () =>
          updateDraftPayment(receiptId, { memo: "stale save" }, userId, org.orgId, {
            allowedSubsidiaryIds: null,
            expectedRevision: revision,
          }),
        PaymentRevisionConflictError,
      );
      // After the draft leaves draft status the recorded rate is frozen.
      const submission = await submitAndReleaseIfUngated("customer_payment", receiptId, userId);
      assert.equal(submission.gated, false);
      await assert.rejects(
        () =>
          updateDraftPayment(receiptId, { explicitFx: null }, userId, org.orgId, {
            allowedSubsidiaryIds: null,
          }),
        (error: unknown) =>
          error instanceof PaymentError && /only draft payments can be edited/.test(error.message),
      );
      await assertNoFxRates(org.orgId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a pegged rate of 1 measures at par, and a same-currency payment records no evidence",
  { skip: !DB },
  async () => {
    const { org, userId } = await setupOrg();
    try {
      const eurInvoice = await seedPostedDocument(org, userId, {
        kind: "customer_invoice",
        currency: "EUR",
        amount: "100",
        fxRate: "1.1",
      });
      const eurItem = await openItemFor(org.orgId, org.customerId, "ar", eurInvoice);
      const eurAllocations = [sameCurrencyAllocation(eurItem.lineId, "100")];
      const peggedId = await draftPayment(org, userId, {
        kind: "customer_payment",
        currency: "EUR",
        allocations: eurAllocations,
        explicitFx: explicitFx("1", "EUR", "CAD", org.date),
      });
      await postPayment(org, userId, peggedId, "customer_payment", eurAllocations);
      const peggedLines = new Map(
        (await paymentEntryLines(org.orgId, peggedId)).map((line) => [line.name, line.amount]),
      );
      assert.equal(peggedLines.get("Cash"), "100.0000", "a recorded peg measures EUR at par");

      const cadInvoice = await seedPostedDocument(org, userId, {
        kind: "customer_invoice",
        currency: "CAD",
        amount: "100",
        fxRate: "1",
      });
      const cadItem = await openItemFor(org.orgId, org.customerId, "ar", cadInvoice);
      const cadAllocations = [sameCurrencyAllocation(cadItem.lineId, "100")];
      const plainId = await draftPayment(org, userId, {
        kind: "customer_payment",
        currency: "CAD",
        allocations: cadAllocations,
      });
      const stored = await storedEvidence(org.orgId, plainId);
      assert.equal(
        stored.document_fx_rate_evidence,
        null,
        "no manual rate means no invented evidence",
      );
      await postPayment(org, userId, plainId, "customer_payment", cadAllocations);
      const plainLines = new Map(
        (await paymentEntryLines(org.orgId, plainId)).map((line) => [line.name, line.amount]),
      );
      assert.equal(plainLines.get("Cash"), "100.0000");
      await assertNoFxRates(org.orgId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "the allocation settlement rate stays independent of the payment's functional rate",
  { skip: !DB },
  async () => {
    const { org, userId } = await setupOrg();
    try {
      // USD invoice carried at 1.30 CAD; a EUR receipt settles it at the
      // evidenced allocation rate 1.1 USD per EUR while the receipt itself is
      // measured into CAD at its own recorded 1.43.
      const invoiceId = await seedPostedDocument(org, userId, {
        kind: "customer_invoice",
        currency: "USD",
        amount: "1100",
        fxRate: "1.3",
      });
      const item = await openItemFor(org.orgId, org.customerId, "ar", invoiceId);
      const allocations: AllocationInput[] = [
        {
          openLineId: item.lineId,
          sourceTransactionAmount: "1000",
          targetTransactionAmount: "1100",
          settlementRate: "1.1",
          settlementRateSource: "manual",
          settlementRateReference: "Bank advice EUR/USD",
        },
      ];
      const receiptId = await draftPayment(org, userId, {
        kind: "customer_payment",
        currency: "EUR",
        allocations,
        explicitFx: explicitFx("1.43", "EUR", "CAD", org.date),
      });
      await postPayment(org, userId, receiptId, "customer_payment", allocations);
      const lines = new Map(
        (await paymentEntryLines(org.orgId, receiptId)).map((line) => [line.name, line.amount]),
      );
      assert.equal(
        lines.get("Cash"),
        "1430.0000",
        "functional measurement uses the payment evidence only",
      );
      const [application] = await applicationsOf(org.orgId, receiptId);
      assert.equal(
        application!.settlement_rate,
        "1.1000000000",
        "the allocation keeps its own EUR to USD rate",
      );
      assert.equal(application!.amount, "1430.0000");
      assert.equal(
        application!.fx_gain_loss_entry_id,
        null,
        "the two conversions agree, so nothing is realized",
      );
      await assertNoFxRates(org.orgId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "one entity's recorded rate never measures another entity's payment",
  { skip: !DB },
  async () => {
    const { org, userId } = await setupOrg();
    try {
      const otherSubsidiaryId = randomUUID();
      await db.execute(sql`
      insert into subsidiaries (id, org_id, name, base_currency, country, parent_id)
      values (${otherSubsidiaryId}, ${org.orgId}, 'US entity', 'USD', 'US', ${org.subsidiaryId})`);
      const cadReceipt = await draftPayment(org, userId, {
        kind: "customer_payment",
        currency: "EUR",
        allocations: [],
        explicitFx: explicitFx("1.115", "EUR", "CAD", org.date),
      });
      const usdReceipt = await draftPayment(org, userId, {
        kind: "customer_payment",
        currency: "EUR",
        allocations: [],
        subsidiaryId: otherSubsidiaryId,
        explicitFx: explicitFx("1.09", "EUR", "USD", org.date),
      });
      assert.equal(
        (await storedEvidence(org.orgId, cadReceipt)).document_fx_rate_evidence?.rate,
        "1.115",
      );
      const usdStored = await storedEvidence(org.orgId, usdReceipt);
      assert.equal(usdStored.document_fx_rate_evidence?.rate, "1.09");
      assert.equal(usdStored.document_fx_rate_evidence?.toCurrency, "USD");
      await assertNoFxRates(org.orgId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "CPA oracle: a USD 1115 receipt settles a EUR 1000 invoice through the per-application settlement rate",
  { skip: !DB },
  async () => {
    const { org, userId } = await setupOrg();
    try {
      // USD-functional entity: the EUR invoice is carried at 1.10 (1100 USD).
      // The receipt itself is USD — no header rate election exists or is
      // needed; the existing per-application manual settlement rate converts
      // the USD source into the EUR open item (EUR per USD, the reciprocal
      // of 1.115), evidenced by its reference.
      await db.execute(
        sql`update subsidiaries set base_currency = 'USD' where id = ${org.subsidiaryId} and org_id = ${org.orgId}`,
      );
      const invoiceId = await seedPostedDocument(org, userId, {
        kind: "customer_invoice",
        currency: "EUR",
        amount: "1000",
        fxRate: "1.1",
      });
      const item = await openItemFor(org.orgId, org.customerId, "ar", invoiceId);
      const allocations: AllocationInput[] = [
        {
          openLineId: item.lineId,
          sourceTransactionAmount: "1115",
          targetTransactionAmount: "1000",
          settlementRate: "0.8968609865",
          settlementRateSource: "manual",
          settlementRateReference: "Bank advice USD/EUR",
        },
      ];
      const receiptId = await draftPayment(org, userId, {
        kind: "customer_payment",
        currency: "USD",
        allocations,
      });
      assert.equal(
        (await storedEvidence(org.orgId, receiptId)).document_fx_rate_evidence,
        null,
        "a USD-functional receipt records no header foreign-rate election",
      );
      await postPayment(org, userId, receiptId, "customer_payment", allocations);
      const lines = new Map(
        (await paymentEntryLines(org.orgId, receiptId)).map((line) => [line.name, line.amount]),
      );
      assert.equal(
        lines.get("Cash"),
        "1115.0000",
        "the USD bank source amount is preserved exactly",
      );
      const [application] = await applicationsOf(org.orgId, receiptId);
      assert.equal(
        application!.settlement_rate,
        "0.8968609865",
        "the allocation presents EUR per USD exactly",
      );
      assert.equal(application!.amount, "1100.0000", "AR relief is the invoice carrying amount");
      const fx = new Map(
        (await fxLinesOf(org.orgId, application!.fx_gain_loss_entry_id!)).map((line) => [
          line.name,
          line.amount,
        ]),
      );
      assert.equal(
        fx.get("Realized FX Gain or Loss"),
        "-15.0000",
        "the 15 difference is a realized gain",
      );
      await assertNoFxRates(org.orgId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "CPA oracle: a USD 745 payment settles a CAD 1000 bill through the per-application settlement rate",
  { skip: !DB },
  async () => {
    const { org, userId } = await setupOrg();
    try {
      // USD-functional entity: the CAD bill is carried at 0.74 (740 USD). The
      // USD payment converts into the CAD open item at the evidenced
      // per-application rate (CAD per USD, the reciprocal of 0.745).
      await db.execute(
        sql`update subsidiaries set base_currency = 'USD' where id = ${org.subsidiaryId} and org_id = ${org.orgId}`,
      );
      const billId = await seedPostedDocument(org, userId, {
        kind: "vendor_bill",
        currency: "CAD",
        amount: "1000",
        fxRate: "0.74",
      });
      const item = await openItemFor(org.orgId, org.vendorId, "ap", billId);
      const allocations: AllocationInput[] = [
        {
          openLineId: item.lineId,
          sourceTransactionAmount: "745",
          targetTransactionAmount: "1000",
          settlementRate: "1.3422818792",
          settlementRateSource: "manual",
          settlementRateReference: "Bank advice USD/CAD",
        },
      ];
      const paymentId = await draftPayment(org, userId, {
        kind: "vendor_payment",
        currency: "USD",
        allocations,
      });
      assert.equal(
        (await storedEvidence(org.orgId, paymentId)).document_fx_rate_evidence,
        null,
        "a USD-functional payment records no header foreign-rate election",
      );
      await postPayment(org, userId, paymentId, "vendor_payment", allocations);
      const lines = new Map(
        (await paymentEntryLines(org.orgId, paymentId)).map((line) => [line.name, line.amount]),
      );
      assert.equal(
        lines.get("Cash"),
        "-745.0000",
        "the USD bank source amount is preserved exactly",
      );
      const [application] = await applicationsOf(org.orgId, paymentId);
      assert.equal(
        application!.settlement_rate,
        "1.3422818792",
        "the allocation presents CAD per USD exactly",
      );
      assert.equal(application!.amount, "740.0000", "AP relief is the bill carrying amount");
      const fx = new Map(
        (await fxLinesOf(org.orgId, application!.fx_gain_loss_entry_id!)).map((line) => [
          line.name,
          line.amount,
        ]),
      );
      assert.equal(
        fx.get("Realized FX Gain or Loss"),
        "5.0000",
        "the 5 difference is a realized loss",
      );
      await assertNoFxRates(org.orgId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "voiding a posted receipt reverses its exact original lines and preserves its rate history",
  { skip: !DB },
  async () => {
    const { org, userId } = await setupOrg();
    try {
      const invoiceId = await seedPostedDocument(org, userId, {
        kind: "customer_invoice",
        currency: "EUR",
        amount: "1000",
        fxRate: "1.1",
      });
      const item = await openItemFor(org.orgId, org.customerId, "ar", invoiceId);
      const allocations = [sameCurrencyAllocation(item.lineId, "1000")];
      const receiptId = await draftPayment(org, userId, {
        kind: "customer_payment",
        currency: "EUR",
        allocations,
        explicitFx: explicitFx("1.115", "EUR", "CAD", org.date),
      });
      await postPayment(org, userId, receiptId, "customer_payment", allocations);
      const original = await paymentEntryLines(org.orgId, receiptId);

      const voided = await withBypass(() =>
        requestDocumentVoid({
          documentId: receiptId,
          orgId: org.orgId,
          actorId: userId,
          reason: "Receipt recorded against the wrong deposit",
          reversalDate: org.date,
          source: "api",
        }),
      );
      assert.equal(voided.status, "voided");
      const reversal = await db.execute<{ name: string; amount: string }>(
        sql`
      select a.name, jl.amount::text as amount
        from documents d
        join journal_lines jl on jl.entry_id = d.reversal_entry_id and jl.org_id = d.org_id
        join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
       where d.org_id = ${org.orgId} and d.id = ${receiptId}
       order by a.name`,
        "objects",
      );
      assert.deepEqual(
        reversal.map((line) => [line.name, line.amount]),
        original.map((line) => [
          line.name,
          line.amount.startsWith("-") ? line.amount.slice(1) : `-${line.amount}`,
        ]),
        "the reversal mirrors the original entry line for line",
      );
      const [application] = await applicationsOf(org.orgId, receiptId);
      assert.ok(application!.unapplied_at, "the application is released, not deleted");
      const reopened = await openItemFor(org.orgId, org.customerId, "ar", invoiceId);
      assert.equal(reopened.transactionOpen, "1000.0000");
      const stored = await storedEvidence(org.orgId, receiptId);
      assert.equal(stored.status, "voided");
      assert.equal(
        stored.document_fx_rate_evidence?.rate,
        "1.115",
        "voiding preserves the recorded rate history",
      );
      await assertNoFxRates(org.orgId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
