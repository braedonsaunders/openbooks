import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  PspSettlementError,
  PspSettlementConflictError,
  importSettlementBatch,
  parseChargebeeSettlement,
  parsePaypalSettlementCsv,
  parsePaypalTransactions,
  parseRecurlySettlement,
  parseShopifyPaymentsPayout,
  parseSquarePayout,
  parseStripeBalanceTransactions,
  postSettlementBatch,
  primaryBookId,
  reverseSettlementBatch,
  savePspProviderConfig,
  summarizeSettlement,
  type ParsedSettlement,
} from "@openbooks/engine/payments/psp-settlement";
import { loadSubsidiaryContext } from "@openbooks/engine/organization/subsidiaries";
import { businessToday, isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import {
  accruePayoutsInTransit,
  batchDepositTieout,
  clearSettlementBatchJournal,
  clearSettlementLineDocument,
  clearSettlementLineJournal,
  deleteSettlementDraft,
  markSettlementBatchJournal,
  markSettlementLineAdjustment,
  markSettlementLineJournal,
  setSettlementLineDocument,
  suggestSettlementBatchJournal,
} from "@openbooks/engine/payments/settlement";
import { CommerceError, matchPayoutLines } from "@openbooks/engine/commerce";
import { can, guardSubsidiaryScope, guardUnrestrictedScope } from "../../../../lib/authz";
import {
  ScopeNotFoundError,
  subsidiaryVisibleFilter,
  UnrestrictedScopeError,
} from "@openbooks/engine/organization/scope";
import { isFeatureEnabled, subsidiaryFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";
import { exactMoney, isoDate } from "@/lib/api/json";
// Settlement-side provider configuration covers the six importable
// providers only: acceptance-only providers keep their automation half on
// the acceptance setup route, whose saves the engine merges by field.
const configProvider = z.enum([
  "stripe",
  "recurly",
  "chargebee",
  "shopify_payments",
  "paypal",
  "square",
]);
const accountReference = uuidString().nullable().optional();
const subsidiaryReference = uuidString().nullable().optional();
const calendarDateShape = isoDate("must be a valid calendar date");
const providerCurrency = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "must be a three-letter currency code");
const recurlyAmount = (field: string) =>
  exactMoney(`${field} must be decimal text; JSON numbers are refused`);
const chargebeeMinorUnits = z.number().int().safe();

const stripeTransaction = z.strictObject({
  id: z.string().trim().min(1, "transaction id is required"),
  type: z.string().trim().min(1, "transaction type is required"),
  amount: z.number().int().safe(),
  fee: z.number().int().safe().optional(),
  net: z.number().int().safe().optional(),
  currency: providerCurrency,
  created: z.number().int().safe().optional(),
  description: z.string().nullable().optional(),
  available_on: z.number().int().safe().optional(),
});

const recurlyPayload = z.strictObject({
  id: z.string().trim().min(1, "Recurly settlement id is required"),
  closed_at: calendarDateShape.optional(),
  currency: providerCurrency,
  charge_amount: recurlyAmount("charge_amount").optional(),
  refund_amount: recurlyAmount("refund_amount").optional(),
  fee_amount: recurlyAmount("fee_amount").optional(),
  net_amount: recurlyAmount("net_amount").optional(),
  lines: z
    .array(
      z.strictObject({
        type: z.string().trim().min(1),
        amount: recurlyAmount("line amount"),
        id: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
});

const chargebeePayload = z.strictObject({
  id: z.string().trim().min(1, "Chargebee invoice id is required"),
  date: z.union([chargebeeMinorUnits, calendarDateShape]).optional(),
  currency_code: providerCurrency,
  total: chargebeeMinorUnits.optional(),
  amount_paid: chargebeeMinorUnits.optional(),
  amount_adjusted: chargebeeMinorUnits.optional(),
  adjustment_reason: z.string().nullable().optional(),
  credits_applied: chargebeeMinorUnits.optional(),
  line_items: z
    .array(
      z.strictObject({
        id: z.string().optional(),
        description: z.string().optional(),
        amount: chargebeeMinorUnits.optional(),
        entity_type: z.string().optional(),
      }),
    )
    .optional(),
});

const importAccountReferences = {
  bankAccountId: accountReference,
  feeAccountId: accountReference,
  disputeAccountId: accountReference,
  fxAccountId: accountReference,
  clearingAccountId: accountReference,
  subsidiaryId: subsidiaryReference,
};

/** Cross-currency evidence for one batch: the provider's own rate, never an
 *  assumed one. The engine re-validates the shape and refuses a missing rate
 *  naming the field, so the boundary stays permissive about JSON numbers. */
const fxEvidence = z.strictObject({
  sourceCurrency: providerCurrency,
  rate: z.union([z.string().trim().min(1), z.number()]),
  rateSource: z.string().trim().min(1, "rate source is required"),
  payoutRate: z.union([z.string().trim().min(1), z.number()]).optional(),
  payoutRateSource: z.string().trim().min(1).optional(),
});

// Provider payloads evolve independently of this product, so the two newest
// shapes stay loose objects: unknown provider fields ride through to the
// engine, which validates the semantics it posts. Only the three original
// shapes keep their strict contracts.
const decimalAmount = z.union([z.string().trim().min(1), z.number()]);

const shopifyPayout = z.object({
  id: z.string().trim().min(1, "Shopify Payments payout id is required"),
  currency: providerCurrency.optional().nullable(),
  amount: decimalAmount.optional().nullable(),
  net: decimalAmount.optional().nullable(),
  issuedAt: z.string().optional().nullable(),
});

const shopifyTransaction = z.object({
  id: z.string().optional().nullable(),
  type: z.string().trim().min(1, "balance transaction type is required"),
  amount: decimalAmount,
  fee: decimalAmount.optional().nullable(),
  net: decimalAmount.optional().nullable(),
  currency: providerCurrency.optional().nullable(),
  exchange_rate: decimalAmount.optional().nullable(),
  sourceOrderId: z.string().optional().nullable(),
});

const paypalMoney = z.object({
  currency_code: z.string().optional().nullable(),
  value: decimalAmount.optional().nullable(),
});

const paypalTransactionInfo = z.object({
  transaction_id: z.string().optional().nullable(),
  transaction_event_code: z.string().optional().nullable(),
  transaction_initiated_date: z.string().optional().nullable(),
  transaction_updated_date: z.string().optional().nullable(),
  transaction_amount: paypalMoney.optional().nullable(),
  fee_amount: paypalMoney.optional().nullable(),
});

const paypalTransaction = z.object({
  transaction_info: paypalTransactionInfo.optional().nullable(),
});

// Square money arrives as integer minor units; the engine refuses anything
// that is not an exact integer and names the field.
const squareMoney = z.object({
  amount: decimalAmount,
  currency: z.string().optional().nullable(),
});

const squarePayout = z.object({
  id: z.string().trim().min(1, "Square payout id is required"),
  status: z.string().optional().nullable(),
  arrival_date: z.string().optional().nullable(),
  created_at: z.string().optional().nullable(),
  amount_money: squareMoney,
});

const squarePayoutEntry = z.object({
  id: z.string().optional().nullable(),
  payout_id: z.string().optional().nullable(),
  effective_at: z.string().optional().nullable(),
  type: z.string().trim().min(1, "Square payout entry type is required"),
  gross_amount_money: squareMoney,
  fee_amount_money: squareMoney.optional().nullable(),
  net_amount_money: squareMoney,
  type_charge_details: z
    .object({ payment_id: z.string().optional().nullable() })
    .optional()
    .nullable(),
  type_refund_details: z
    .object({ payment_id: z.string().optional().nullable() })
    .optional()
    .nullable(),
  type_dispute_details: z
    .object({ dispute_id: z.string().optional().nullable() })
    .optional()
    .nullable(),
});

const importBody = z.discriminatedUnion("provider", [
  z
    .strictObject({
      action: z.literal("import"),
      provider: z.literal("stripe"),
      externalRef: z.string().trim().min(1).optional(),
      payoutId: z.string().trim().min(1).optional(),
      settlementDate: calendarDateShape.optional(),
      transactions: z
        .array(stripeTransaction)
        .min(1, "at least one Stripe transaction is required"),
      fx: fxEvidence.optional(),
      ...importAccountReferences,
    })
    .refine((body) => Boolean(body.externalRef ?? body.payoutId), {
      path: ["externalRef"],
      message: "externalRef or payoutId is required",
    }),
  z.strictObject({
    action: z.literal("import"),
    provider: z.literal("recurly"),
    settlementDate: calendarDateShape.optional(),
    payload: recurlyPayload,
    fx: fxEvidence.optional(),
    ...importAccountReferences,
  }),
  z.strictObject({
    action: z.literal("import"),
    provider: z.literal("chargebee"),
    settlementDate: calendarDateShape.optional(),
    payload: chargebeePayload,
    fx: fxEvidence.optional(),
    ...importAccountReferences,
  }),
  z.strictObject({
    action: z.literal("import"),
    provider: z.literal("shopify_payments"),
    externalRef: z.string().trim().min(1).optional(),
    settlementDate: calendarDateShape.optional(),
    payout: shopifyPayout,
    transactions: z
      .array(shopifyTransaction)
      .min(1, "at least one Shopify balance transaction is required"),
    fx: fxEvidence.optional(),
    ...importAccountReferences,
  }),
  z
    .strictObject({
      action: z.literal("import"),
      provider: z.literal("paypal"),
      // A Transaction Search export carries no natural reference: the operator
      // names the export (statement week, settlement id) so the batch stays
      // idempotent on (provider, external ref).
      externalRef: z.string().trim().min(1, "externalRef names this PayPal export"),
      settlementDate: calendarDateShape.optional(),
      payload: z
        .object({
          transactions: z
            .array(paypalTransaction)
            .min(1, "at least one PayPal transaction is required"),
        })
        .optional(),
      // PayPal settlement report (STL) CSV text, header row included.
      csv: z.string().min(1).optional(),
      fx: fxEvidence.optional(),
      ...importAccountReferences,
    })
    .refine((body) => body.payload !== undefined || body.csv !== undefined, {
      message: "payload or csv is required",
    }),
  z.strictObject({
    action: z.literal("import"),
    provider: z.literal("square"),
    // The operator's reference must name the Square payout: the payout id is
    // the batch's idempotency key, and the handler refuses any other value.
    externalRef: z.string().trim().min(1).optional(),
    settlementDate: calendarDateShape.optional(),
    payout: squarePayout,
    entries: z.array(squarePayoutEntry).min(1, "at least one Square payout entry is required"),
    fx: fxEvidence.optional(),
    ...importAccountReferences,
  }),
]);

const postBodySchema0 = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("saveConfig"),
    provider: configProvider,
    displayName: z.string().trim().min(1).optional(),
    isEnabled: z.boolean({ error: "isEnabled must be a boolean" }).optional(),
    defaultBankAccountId: accountReference,
    defaultFeeAccountId: accountReference,
    defaultDisputeAccountId: accountReference,
    defaultFxAccountId: accountReference,
    defaultClearingAccountId: accountReference,
    defaultDisputedFundsAccountId: accountReference,
    defaultChargebackLossAccountId: accountReference,
    defaultDisputeFeeAccountId: accountReference,
    pullEnabled: z.boolean({ error: "pullEnabled must be a boolean" }).optional(),
    apiKey: z.string().nullable().optional(),
  }),
  importBody,
  // A malformed batch id is refused as a tenant-opaque 404 by the handler
  // below; the boundary only enforces the string shape so the id never
  // reaches a uuid cast that dies as a storage 500.
  z.strictObject({ action: z.literal("post"), batchId: z.string() }),
  z.strictObject({
    action: z.literal("reverse"),
    batchId: z.string(),
    reversalDate: calendarDateShape,
    reason: z.string().trim().min(1).max(500),
  }),
  // Payout-to-order reconciliation: match every line to its native document,
  // link or unlink one line, reclassify a line as an adjustment, or run the
  // month-end in-transit accrual. Ids stay strings at the boundary so a
  // malformed id refuses as a tenant-opaque 404 in the handler, never as a
  // uuid cast 500.
  z.strictObject({ action: z.literal("match"), batchId: z.string() }),
  z.strictObject({
    action: z.literal("link"),
    batchId: z.string(),
    lineId: z.string(),
    documentId: z.string(),
  }),
  z.strictObject({
    action: z.literal("unlink"),
    batchId: z.string(),
    lineId: z.string(),
  }),
  z.strictObject({
    action: z.literal("markAdjustment"),
    batchId: z.string(),
    lineId: z.string(),
  }),
  z.strictObject({
    action: z.literal("markJournal"),
    batchId: z.string(),
    lineId: z.string(),
    journalEntryId: z.string(),
  }),
  z.strictObject({
    action: z.literal("unmarkJournal"),
    batchId: z.string(),
    lineId: z.string(),
  }),
  // Batch-level journal recognition: one entry evidences every unevidenced
  // matchable line, suggested by exact charge-to-revenue equality and
  // confirmed by the operator; reversible until the payout period closes.
  z.strictObject({
    action: z.literal("markBatchJournal"),
    batchId: z.string(),
    journalEntryId: z.string(),
  }),
  z.strictObject({
    action: z.literal("unmarkBatchJournal"),
    batchId: z.string(),
  }),
  z.strictObject({
    action: z.literal("deleteDraft"),
    batchId: z.string(),
    reason: z.string().trim().min(1).max(500),
  }),
  z.strictObject({ action: z.literal("accrue"), accrualDate: calendarDateShape }),
]);

export const runtime = "nodejs";

/**
 * Provider exports use explicit nulls where the engine's parser inputs use
 * absent optionals. Normalizing once at the boundary keeps every dispatch
 * below free of per-field null handling the engine never observes.
 */
type NullsToUndefined<T> = T extends null
  ? undefined
  : T extends Array<infer Item>
    ? Array<NullsToUndefined<Item>>
    : T extends Record<string, unknown>
      ? { [Key in keyof T]: NullsToUndefined<T[Key]> }
      : T;

function nullsToUndefined<T>(value: T): NullsToUndefined<T> {
  if (Array.isArray(value)) {
    return value.map(nullsToUndefined) as NullsToUndefined<T>;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        entry === null ? undefined : nullsToUndefined(entry),
      ]),
    ) as NullsToUndefined<T>;
  }
  return value as NullsToUndefined<T>;
}

export const GET = defineRoute({
  permission: "banking.read",
  feature: "banking",
  handler: async ({ request: req, authz: gate }) => {
    const orgId = gate.user.orgId;
    // Settlement detail for the reconciliation drawer: one batch with its
    // evidence lines and the linked receipt numbers, under the same scope as
    // the list. A malformed id is a tenant-opaque 404, never a uuid cast 500.
    const batchId = new URL(req.url).searchParams.get("batchId");
    // Journal picker for manual journal recognition: posted entries the
    // caller may see whose number contains the query, newest first. A
    // restricted caller never learns another entity's entry numbers through
    // the picker.
    const resolveEntry = new URL(req.url).searchParams.get("resolveEntry");
    if (resolveEntry !== null && resolveEntry.trim() !== "") {
      const query = `%${resolveEntry.trim().replace(/[%_\\]/g, "")}%`;
      const entries = await db.execute(
        sql`
        select e.id, e.entry_number as "entryNumber",
               e.posting_date::text as "postingDate", e.status
          from journal_entries e
         -- Live entries only: the picker offers standing entries to match
         where e.org_id = ${orgId} and e.status = 'posted'
           and e.entry_number ilike ${query}
           ${subsidiaryVisibleFilter(sql`e.subsidiary_id`, gate.allowedSubsidiaryIds)}
         order by e.posting_date desc, e.entry_number
         limit 10
      `,
        "objects",
      );
      return NextResponse.json({ entries });
    }
    // Document picker for manual line links: posted documents the caller may
    // see whose number contains the query, newest first. A restricted caller
    // never learns another entity's receipt numbers through the picker.
    const resolveDoc = new URL(req.url).searchParams.get("resolveDoc");
    if (resolveDoc !== null && resolveDoc.trim() !== "") {
      const query = `%${resolveDoc.trim().replace(/[%_\\]/g, "")}%`;
      const docs = await db.execute(
        sql`
        select d.id, d.kind, d.document_number as "documentNumber",
               d.total::text as total, d.currency, d.document_date::text as "documentDate"
          from documents d
         where d.org_id = ${orgId} and d.status = 'posted'
           and d.document_number ilike ${query}
           ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, gate.allowedSubsidiaryIds)}
         order by d.document_date desc, d.document_number
         limit 10
      `,
        "objects",
      );
      return NextResponse.json({ documents: docs });
    }
    // Batch journal suggestion: posted entries whose revenue lines total
    // exactly the batch's charge total, for the operator to confirm. A
    // restricted caller never learns another entity's entries: the engine
    // filters by the same scope the batch reads.
    const suggestJournal = new URL(req.url).searchParams.get("suggestJournal");
    if (suggestJournal !== null && suggestJournal.trim() !== "") {
      if (!isUuid(suggestJournal)) return notFound("record");
      try {
        return NextResponse.json(
          await suggestSettlementBatchJournal(orgId, suggestJournal, gate.allowedSubsidiaryIds),
        );
      } catch (e) {
        if (e instanceof ScopeNotFoundError) return notFound("record");
        if (e instanceof PspSettlementError) return apiErrorResponse(e, { safeStatus: 422 });
        throw e;
      }
    }
    if (batchId !== null) {
      if (!isUuid(batchId)) return notFound("record");
      const scopedBatch = gate.allowedSubsidiaryIds
        ? gate.allowedSubsidiaryIds.size > 0
          ? sql` and b.subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(",")}}`}::uuid[])`
          : sql` and false`
        : sql``;
      const batch = await db.execute(
        sql`
        select b.id, b.provider, b.external_ref as "externalRef", b.status, b.currency,
               b.source_currency as "sourceCurrency", b.conversion_rate::text as "conversionRate",
               b.conversion_rate_source as "conversionRateSource", b.payout_rate::text as "payoutRate",
               b.payout_rate_source as "payoutRateSource",
               b.gross_amount as "grossAmount", b.fee_amount as "feeAmount",
               b.refund_amount as "refundAmount", b.dispute_amount as "disputeAmount",
               b.adjustment_amount as "adjustmentAmount", b.fx_amount as "fxAmount",
               b.net_amount as "netAmount", b.settlement_date::text as "settlementDate",
               b.journal_entry_id as "journalEntryId", b.reversal_entry_id as "reversalEntryId",
               b.reversal_reason as "reversalReason", b.memo, b.line_count as "lineCount",
               b.subsidiary_id as "subsidiaryId", j.subsidiary_id as "recordedSubsidiaryId",
               j.book_id as "recordedBookId",
               b.bank_account_id as "bankAccountId", concat_ws(' · ', bank.number, bank.name) as "bankAccountLabel",
               b.fee_account_id as "feeAccountId", concat_ws(' · ', fee.number, fee.name) as "feeAccountLabel",
               b.clearing_account_id as "clearingAccountId", concat_ws(' · ', clearing.number, clearing.name) as "clearingAccountLabel",
               b.dispute_account_id as "disputeAccountId", concat_ws(' · ', dispute.number, dispute.name) as "disputeAccountLabel",
               b.fx_account_id as "fxAccountId", concat_ws(' · ', fx.number, fx.name) as "fxAccountLabel"
          from psp_settlement_batches b
          left join journal_entries j on j.org_id = b.org_id and j.id = b.journal_entry_id
          left join accounts bank on bank.org_id = b.org_id and bank.id = b.bank_account_id
          left join accounts fee on fee.org_id = b.org_id and fee.id = b.fee_account_id
          left join accounts clearing on clearing.org_id = b.org_id and clearing.id = b.clearing_account_id
          left join accounts dispute on dispute.org_id = b.org_id and dispute.id = b.dispute_account_id
          left join accounts fx on fx.org_id = b.org_id and fx.id = b.fx_account_id
         where b.org_id = ${orgId} and b.id = ${batchId}${scopedBatch}
         limit 1
      `,
        "objects",
      );
      const row = batch[0] as Record<string, unknown> | undefined;
      if (!row) return notFound("record");
      // Drafts use the same entity and primary-book resolution as posting;
      // posted history keeps the actual journal identity even if Setup changes.
      const context = await loadSubsidiaryContext(db, orgId);
      const postingEntityId =
        row.status === "draft"
          ? (row.subsidiaryId ?? (context.multi ? null : context.rootId))
          : row.recordedSubsidiaryId;
      let postingBookId = row.recordedBookId ?? null;
      if (row.status === "draft") {
        try {
          postingBookId = await primaryBookId(orgId);
        } catch (error) {
          if (!(error instanceof PspSettlementError)) throw error;
        }
      }
      const book = postingBookId
        ? (
            await db.execute<{ name: string }>(
              sql`
            select name from accounting_books where org_id = ${orgId} and id = ${postingBookId}
          `,
              "objects",
            )
          )[0]
        : undefined;
      const review = {
        postingEntityId: postingEntityId ?? null,
        postingEntityName:
          typeof postingEntityId === "string"
            ? (context.byId.get(postingEntityId)?.name ?? null)
            : null,
        postingBookId,
        postingBookName: book?.name ?? null,
        postingBasis: row.status === "draft" ? "current" : "recorded",
      };
      const lines = await db.execute(
        sql`
        select l.id, l.line_number as "lineNumber", l.kind, l.external_ref as "externalRef",
               l.description, l.amount, l.currency, l.document_id as "documentId",
               d.kind as "documentKind", d.document_number as "documentNumber",
               l.meta->'recognizedByJournalEntry'->>'id' as "journalEntryId",
               l.meta->'recognizedByJournalEntry'->>'number' as "journalEntryNumber"
          from psp_settlement_lines l
          left join documents d on d.org_id = l.org_id and d.id = l.document_id
         where l.org_id = ${orgId} and l.batch_id = ${batchId}
         order by l.line_number
      `,
        "objects",
      );
      // The payout drawer reads the deposit tie-out and any in-transit
      // accruals beside the lines: both derive from posted state, so the
      // detail carries them instead of growing new endpoints.
      const tieout = await batchDepositTieout(orgId, batchId, gate.allowedSubsidiaryIds);
      const accruals = await db.execute(
        sql`
        select id, accrual_date::text as "accrualDate", reversal_date::text as "reversalDate",
               amount, currency, accrual_entry_id as "accrualEntryId",
               reversal_entry_id as "reversalEntryId", status
          from psp_payout_accruals
         where org_id = ${orgId} and batch_id = ${batchId}
         order by accrual_date
      `,
        "objects",
      );
      return NextResponse.json({ batch: { ...row, ...review }, lines, tieout, accruals });
    }
    const subsidiaryFilter = gate.allowedSubsidiaryIds
      ? gate.allowedSubsidiaryIds.size > 0
        ? sql` and subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(",")}}`}::uuid[])`
        : sql` and false`
      : sql``;
    // The import form's subsidiary picker reads the same scope the batches do:
    // multi-subsidiary orgs pick the posting entity up front, while
    // single-entity orgs get no options and post to the root like every other
    // document. Restricted callers see only their own entities.
    const subsidiaryIdFilter = gate.allowedSubsidiaryIds
      ? gate.allowedSubsidiaryIds.size > 0
        ? sql` and id = any(${`{${[...gate.allowedSubsidiaryIds].join(",")}}`}::uuid[])`
        : sql` and false`
      : sql``;
    const subsidiaries = (await subsidiaryFeatureEnabled(orgId))
      ? await db.execute(
          sql`
      select id, name, base_currency as "baseCurrency"
        from subsidiaries
       where org_id = ${orgId} and is_active and not is_elimination${subsidiaryIdFilter}
       order by name
    `,
          "objects",
        )
      : [];
    const [batches, configs] = await Promise.all([
      db.execute(
        sql`
      select id, provider, external_ref as "externalRef", status, currency, net_amount as "netAmount",
             fee_amount as "feeAmount", gross_amount as "grossAmount", refund_amount as "refundAmount",
             dispute_amount as "disputeAmount", adjustment_amount as "adjustmentAmount",
             fx_amount as "fxAmount", source_currency as "sourceCurrency",
             settlement_date as "settlementDate", journal_entry_id as "journalEntryId",
             reversal_entry_id as "reversalEntryId", reversal_reason as "reversalReason",
             reversed_at as "reversedAt", reversed_by as "reversedBy",
             memo, line_count as "lineCount"
        from psp_settlement_batches where org_id = ${orgId}${subsidiaryFilter}
       order by settlement_date desc, created_at desc
    `,
        "objects",
      ),
      // Provider configuration is organization-wide and has no subsidiary_id.
      // Do not expose it to a restricted caller when its account defaults may
      // span entities; setup administrators can use the dedicated setup route.
      gate.allowedSubsidiaryIds
        ? Promise.resolve([])
        : db.execute(
            sql`
      select id, provider, display_name as "displayName", is_enabled as "isEnabled",
             default_bank_account_id as "defaultBankAccountId",
             default_fee_account_id as "defaultFeeAccountId",
             default_dispute_account_id as "defaultDisputeAccountId",
             default_fx_account_id as "defaultFxAccountId",
             default_clearing_account_id as "defaultClearingAccountId",
             default_disputed_funds_account_id as "defaultDisputedFundsAccountId",
             default_chargeback_loss_account_id as "defaultChargebackLossAccountId",
             default_dispute_fee_account_id as "defaultDisputeFeeAccountId"
        from psp_provider_configs where org_id = ${orgId}
    `,
            "objects",
          ),
    ]);
    return NextResponse.json({
      batches,
      configs,
      subsidiaries,
    });
  },
});

export const POST = defineRoute({
  public: "session",
  body: postBodySchema0,
  handler: async ({ authz, body }) => {
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!(await isFeatureEnabled(authz.user.orgId, "banking"))) {
      return notFound("record");
    }

    const requiredPermission =
      body.action === "saveConfig" ? "admin.setup.manage" : "banking.reconcile";
    if (!can(authz, requiredPermission)) {
      return NextResponse.json(
        { error: `missing permission: ${requiredPermission}` },
        { status: 403 },
      );
    }
    const orgId = authz.user.orgId;
    const userId = authz.user.id;

    try {
      switch (body.action) {
        case "saveConfig": {
          const scopeDenied = guardUnrestrictedScope(authz);
          if (scopeDenied) return scopeDenied;
          await savePspProviderConfig(
            orgId,
            {
              provider: body.provider,
              displayName: body.displayName,
              isEnabled: body.isEnabled ?? false,
              defaultBankAccountId: body.defaultBankAccountId ?? null,
              defaultFeeAccountId: body.defaultFeeAccountId ?? null,
              defaultDisputeAccountId: body.defaultDisputeAccountId ?? null,
              defaultFxAccountId: body.defaultFxAccountId ?? null,
              defaultClearingAccountId: body.defaultClearingAccountId ?? null,
              defaultDisputedFundsAccountId: body.defaultDisputedFundsAccountId ?? null,
              defaultChargebackLossAccountId: body.defaultChargebackLossAccountId ?? null,
              defaultDisputeFeeAccountId: body.defaultDisputeFeeAccountId ?? null,
              pullEnabled: body.pullEnabled ?? undefined,
              apiKey: body.apiKey ?? null,
            },
            userId,
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json({ ok: true });
        }
        case "import": {
          const denied = guardSubsidiaryScope(authz, body.subsidiaryId ?? null);
          if (denied) return denied;
          const fallbackDate = body.settlementDate ?? (await businessToday(orgId));
          // One branch per settlement provider: adding a provider is a schema
          // variant above plus one case here, and the engine's parser
          // registry stays the single list of supported providers.
          let parsed: ParsedSettlement;
          switch (body.provider) {
            case "stripe":
              parsed = parseStripeBalanceTransactions(
                body.transactions,
                body.externalRef ?? body.payoutId ?? "",
                fallbackDate,
              );
              break;
            case "recurly":
              parsed = parseRecurlySettlement(body.payload, fallbackDate);
              break;
            case "chargebee":
              parsed = parseChargebeeSettlement(body.payload, fallbackDate);
              break;
            case "shopify_payments":
              parsed = parseShopifyPaymentsPayout(
                nullsToUndefined(body.payout),
                nullsToUndefined(body.transactions),
                fallbackDate,
              );
              break;
            case "paypal":
              parsed =
                body.csv !== undefined
                  ? parsePaypalSettlementCsv(body.csv, body.externalRef, fallbackDate)
                  : parsePaypalTransactions(
                      nullsToUndefined({
                        reference: body.externalRef,
                        transactions: body.payload!.transactions,
                      }),
                      fallbackDate,
                    );
              break;
            case "square":
              if (body.externalRef !== undefined && body.externalRef !== body.payout.id.trim()) {
                throw new PspSettlementError(
                  `external ref ${body.externalRef} does not name Square payout ${body.payout.id}; enter the payout id as the external ref`,
                );
              }
              parsed = parseSquarePayout(
                nullsToUndefined(body.payout),
                nullsToUndefined(body.entries),
                fallbackDate,
              );
              break;
          }
          if (body.fx) {
            parsed.fx = {
              sourceCurrency: body.fx.sourceCurrency,
              rate: String(body.fx.rate),
              rateSource: body.fx.rateSource,
              payoutRate: body.fx.payoutRate === undefined ? null : String(body.fx.payoutRate),
              payoutRateSource: body.fx.payoutRateSource ?? null,
            };
          }
          if (!parsed.externalRef)
            return NextResponse.json({ error: "externalRef required" }, { status: 422 });
          const result = await importSettlementBatch(
            orgId,
            userId,
            parsed,
            {
              bankAccountId: body.bankAccountId ?? undefined,
              feeAccountId: body.feeAccountId ?? undefined,
              disputeAccountId: body.disputeAccountId ?? undefined,
              fxAccountId: body.fxAccountId ?? undefined,
              clearingAccountId: body.clearingAccountId ?? undefined,
              subsidiaryId: body.subsidiaryId ?? undefined,
            },
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json({
            ...result,
            totals: summarizeSettlement(parsed.lines),
          });
        }
        case "post": {
          if (!isUuid(body.batchId)) return notFound("record");
          const posted = await postSettlementBatch(
            orgId,
            body.batchId,
            userId,
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(posted);
        }
        case "reverse": {
          if (!isUuid(body.batchId)) return notFound("record");
          // The reversal looks the date's open period up with ::date
          // comparisons: a non-calendar day would otherwise die in Postgres
          // with a raw driver failure, so require a real calendar date first.
          if (!isIsoCalendarDate(body.reversalDate)) {
            return NextResponse.json(
              {
                error: "reversalDate must be a real calendar date (YYYY-MM-DD)",
              },
              { status: 422 },
            );
          }
          if (!body.reason) return NextResponse.json({ error: "reason required" }, { status: 422 });
          const reversed = await reverseSettlementBatch(
            orgId,
            body.batchId,
            userId,
            {
              reversalDate: String(body.reversalDate),
              reason: String(body.reason),
            },
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(reversed);
        }
        case "match": {
          if (!isUuid(body.batchId)) return notFound("record");
          const matched = await matchPayoutLines(
            orgId,
            body.batchId,
            userId,
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(matched);
        }
        case "link": {
          if (!isUuid(body.batchId) || !isUuid(body.lineId)) return notFound("record");
          const linked = await setSettlementLineDocument(
            orgId,
            body.batchId,
            body.lineId,
            body.documentId,
            userId,
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(linked);
        }
        case "unlink": {
          if (!isUuid(body.batchId) || !isUuid(body.lineId)) return notFound("record");
          const unlinked = await clearSettlementLineDocument(
            orgId,
            body.batchId,
            body.lineId,
            userId,
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(unlinked);
        }
        case "markAdjustment": {
          if (!isUuid(body.batchId) || !isUuid(body.lineId)) return notFound("record");
          const marked = await markSettlementLineAdjustment(
            orgId,
            body.batchId,
            body.lineId,
            userId,
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(marked);
        }
        case "markJournal": {
          if (!isUuid(body.batchId) || !isUuid(body.lineId)) return notFound("record");
          const marked = await markSettlementLineJournal(
            orgId,
            body.batchId,
            body.lineId,
            body.journalEntryId,
            userId,
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(marked);
        }
        case "unmarkJournal": {
          if (!isUuid(body.batchId) || !isUuid(body.lineId)) return notFound("record");
          const unmarked = await clearSettlementLineJournal(
            orgId,
            body.batchId,
            body.lineId,
            userId,
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(unmarked);
        }
        case "markBatchJournal": {
          if (!isUuid(body.batchId)) return notFound("record");
          const marked = await markSettlementBatchJournal(
            orgId,
            body.batchId,
            body.journalEntryId,
            userId,
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(marked);
        }
        case "unmarkBatchJournal": {
          if (!isUuid(body.batchId)) return notFound("record");
          const unmarked = await clearSettlementBatchJournal(
            orgId,
            body.batchId,
            userId,
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(unmarked);
        }
        case "deleteDraft": {
          if (!isUuid(body.batchId)) return notFound("record");
          if (!body.reason) return NextResponse.json({ error: "reason required" }, { status: 422 });
          const deleted = await deleteSettlementDraft(
            orgId,
            body.batchId,
            userId,
            { reason: String(body.reason) },
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(deleted);
        }
        case "accrue": {
          const accrued = await accruePayoutsInTransit(
            orgId,
            body.accrualDate,
            userId,
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(accrued);
        }
        default:
          return NextResponse.json({ error: "unknown action" }, { status: 400 });
      }
    } catch (e) {
      if (e instanceof ScopeNotFoundError) {
        return notFound("record");
      }
      // The matcher refuses with its remedy attached; the client reads the
      // refusal before parsing, so the message always reaches the operator.
      if (e instanceof CommerceError) {
        if (e.code === "payout_batch_missing") return notFound("record");
        return apiErrorResponse(e, {
          details: { code: e.code, remedy: e.remedy },
        });
      }
      if (e instanceof PspSettlementConflictError) {
        return apiErrorResponse(e, {
          safeStatus: 409,
          details: { batch: e.persistedBatch },
        });
      }
      if (e instanceof UnrestrictedScopeError) {
        return NextResponse.json(
          { error: "requires unrestricted subsidiary access" },
          { status: 403 },
        );
      }
      if (e instanceof PspSettlementError) {
        return apiErrorResponse(e, { safeStatus: 422 });
      }
      return apiErrorResponse(e);
    }
  },
});
