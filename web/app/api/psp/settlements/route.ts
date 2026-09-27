import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  PspSettlementError,
  PspSettlementConflictError,
  importSettlementBatch,
  parseChargebeeSettlement,
  parseRecurlySettlement,
  parseStripeBalanceTransactions,
  postSettlementBatch,
  reverseSettlementBatch,
  savePspProviderConfig,
  summarizeSettlement,
} from "@openbooks/engine/src/payments/psp-settlement.ts";
import { businessToday, isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import {
  can,
  guardSubsidiaryScope,
  guardUnrestrictedScope,
} from "../../../../lib/authz";
import {
  ScopeNotFoundError,
  UnrestrictedScopeError,
} from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import {
  isFeatureEnabled,
  subsidiaryFeatureEnabled,
} from "../../../../lib/features";
import { notFound } from "@/lib/api/responses";
import { exactMoney, isoDate } from "@/lib/api/json";
const provider = z.enum(["stripe", "recurly", "chargebee"]);
const accountReference = z.uuid().nullable().optional();
const subsidiaryReference = z.uuid().nullable().optional();
const calendarDateShape = isoDate("must be a valid calendar date");
const providerCurrency = z.string().trim().regex(/^[A-Za-z]{3}$/, "must be a three-letter currency code");
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
  lines: z.array(z.strictObject({
    type: z.string().trim().min(1),
    amount: recurlyAmount("line amount"),
    id: z.string().optional(),
    description: z.string().optional(),
  })).optional(),
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
  line_items: z.array(z.strictObject({
    id: z.string().optional(),
    description: z.string().optional(),
    amount: chargebeeMinorUnits.optional(),
    entity_type: z.string().optional(),
  })).optional(),
});

const importAccountReferences = {
  bankAccountId: accountReference,
  feeAccountId: accountReference,
  disputeAccountId: accountReference,
  fxAccountId: accountReference,
  clearingAccountId: accountReference,
  subsidiaryId: subsidiaryReference,
};

const importBody = z.discriminatedUnion("provider", [
  z.strictObject({
    action: z.literal("import"),
    provider: z.literal("stripe"),
    externalRef: z.string().trim().min(1).optional(),
    payoutId: z.string().trim().min(1).optional(),
    settlementDate: calendarDateShape.optional(),
    transactions: z.array(stripeTransaction).min(1, "at least one Stripe transaction is required"),
    ...importAccountReferences,
  }).refine((body) => Boolean(body.externalRef ?? body.payoutId), {
    path: ["externalRef"],
    message: "externalRef or payoutId is required",
  }),
  z.strictObject({
    action: z.literal("import"),
    provider: z.literal("recurly"),
    settlementDate: calendarDateShape.optional(),
    payload: recurlyPayload,
    ...importAccountReferences,
  }),
  z.strictObject({
    action: z.literal("import"),
    provider: z.literal("chargebee"),
    settlementDate: calendarDateShape.optional(),
    payload: chargebeePayload,
    ...importAccountReferences,
  }),
]);

const postBodySchema0 = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("saveConfig"),
    provider,
    displayName: z.string().trim().min(1).optional(),
    isEnabled: z.boolean({ error: "isEnabled must be a boolean" }).optional(),
    defaultBankAccountId: accountReference,
    defaultFeeAccountId: accountReference,
    defaultDisputeAccountId: accountReference,
    defaultFxAccountId: accountReference,
    defaultClearingAccountId: accountReference,
    apiKey: z.string().nullable().optional(),
  }),
  importBody,
  z.strictObject({ action: z.literal("post"), batchId: z.uuid() }),
  z.strictObject({
    action: z.literal("reverse"),
    batchId: z.uuid(),
    reversalDate: calendarDateShape,
    reason: z.string().trim().min(1).max(500),
  }),
]);

export { runtime } from "@/lib/api/route";

export const GET = defineRoute({
  permission: "banking.read",
  feature: "banking",
  handler: async ({ authz: gate }) => {
    const orgId = gate.user.orgId;
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
      ? await db.execute(sql`
      select id, name, base_currency as "baseCurrency"
        from subsidiaries
       where org_id = ${orgId} and is_active and not is_elimination${subsidiaryIdFilter}
       order by name
    `)
      : { rows: [] };
    const [batches, configs] = await Promise.all([
      db.execute(sql`
      select id, provider, external_ref as "externalRef", status, currency, net_amount as "netAmount",
             fee_amount as "feeAmount", settlement_date as "settlementDate", journal_entry_id as "journalEntryId",
             reversal_entry_id as "reversalEntryId", reversal_reason as "reversalReason",
             reversed_at as "reversedAt", reversed_by as "reversedBy",
             memo, line_count as "lineCount"
        from psp_settlement_batches where org_id = ${orgId}${subsidiaryFilter}
       order by settlement_date desc, created_at desc
    `),
      // Provider configuration is organization-wide and has no subsidiary_id.
      // Do not expose it to a restricted caller when its account defaults may
      // span entities; setup administrators can use the dedicated setup route.
      gate.allowedSubsidiaryIds
        ? Promise.resolve({ rows: [] })
        : db.execute(sql`
      select id, provider, display_name as "displayName", is_enabled as "isEnabled",
             default_bank_account_id as "defaultBankAccountId",
             default_fee_account_id as "defaultFeeAccountId",
             default_clearing_account_id as "defaultClearingAccountId"
        from psp_provider_configs where org_id = ${orgId}
    `),
    ]);
    return NextResponse.json({
      batches: batches.rows,
      configs: configs.rows,
      subsidiaries: subsidiaries.rows,
    });
  },
});

export const POST = defineRoute({
  public: "session",
  body: postBodySchema0,
  handler: async ({ authz, body }) => {
    if (!authz)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
          let parsed;
          if (body.provider === "stripe") {
            parsed = parseStripeBalanceTransactions(
              body.transactions,
              body.externalRef ?? body.payoutId ?? "",
              fallbackDate,
            );
          } else if (body.provider === "recurly") {
            parsed = parseRecurlySettlement(
              body.payload,
              fallbackDate,
            );
          } else {
            parsed = parseChargebeeSettlement(
              body.payload,
              fallbackDate,
            );
          }
          if (!parsed.externalRef)
            return NextResponse.json(
              { error: "externalRef required" },
              { status: 422 },
            );
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
          const posted = await postSettlementBatch(
            orgId,
            body.batchId,
            userId,
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(posted);
        }
        case "reverse": {
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
          if (!body.reason)
            return NextResponse.json(
              { error: "reason required" },
              { status: 422 },
            );
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
        default:
          return NextResponse.json(
            { error: "unknown action" },
            { status: 400 },
          );
      }
    } catch (e) {
      if (e instanceof ScopeNotFoundError) {
        return notFound("record");
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
