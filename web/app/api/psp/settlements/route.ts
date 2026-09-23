import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  PspSettlementError,
  importSettlementBatch,
  parseChargebeeSettlement,
  parseRecurlySettlement,
  parseStripeBalanceTransactions,
  postSettlementBatch,
  reverseSettlementBatch,
  savePspProviderConfig,
  summarizeSettlement,
  type PspProvider,
} from "@openbooks/engine/src/payments/psp-settlement.ts";
import { businessToday, isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import { can, getAuthz, guardSubsidiaryScope, guardUnrestrictedScope } from "../../../../lib/authz";
import { ScopeNotFoundError, UnrestrictedScopeError } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { guardFeaturePermission } from "../../../../lib/feature-gates";
import { isFeatureEnabled, subsidiaryFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

export async function GET() {
  const gate = await guardFeaturePermission("banking.read", "banking");
  if (gate instanceof NextResponse) return gate;
  const orgId = gate.user.orgId;
  const subsidiaryFilter = gate.allowedSubsidiaryIds
    ? gate.allowedSubsidiaryIds.size > 0
      ? sql` and subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(",")}}`}::uuid[])`
      : sql` and false`
    : sql``;
  // The import form's subsidiary picker reads the same scope the batches do:
  // multi-subsidiary orgs pick the posting entity up front (F-t06-004), while
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
       order by settlement_date desc, created_at desc limit 50
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
  return NextResponse.json({ batches: batches.rows, configs: configs.rows, subsidiaries: subsidiaries.rows });
}

export async function POST(req: Request) {
  const authz = await getAuthz();
  if (!authz)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await isFeatureEnabled(authz.user.orgId, "banking"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as {
    action?: string; provider?: string; displayName?: string; isEnabled?: boolean;
    defaultBankAccountId?: string; defaultFeeAccountId?: string; defaultDisputeAccountId?: string;
    defaultFxAccountId?: string; defaultClearingAccountId?: string; apiKey?: string;
    subsidiaryId?: string; settlementDate?: string; transactions?: unknown;
    externalRef?: string; payoutId?: string; payload?: unknown;
    bankAccountId?: string; feeAccountId?: string; disputeAccountId?: string;
    fxAccountId?: string; clearingAccountId?: string;
    batchId?: string; reversalDate?: string; reason?: string;
  };
  const requiredPermission =
    body.action === "saveConfig"
      ? "admin.setup.manage"
      : "banking.reconcile";
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
            provider: body.provider as PspProvider,
            displayName: body.displayName,
            isEnabled: Boolean(body.isEnabled),
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
        const provider = body.provider as PspProvider;
        const fallbackDate = String(body.settlementDate ?? (await businessToday(orgId)));
        let parsed;
        // Provider payloads forward the raw JSON to the validating parser,
        // which throws PspSettlementError (mapped to 422 below) on shape
        // violations — the same value as before, only statically described.
        const providerPayload =
          typeof body.payload === "object" && body.payload !== null ? body.payload : body;
        if (provider === "stripe") {
          parsed = parseStripeBalanceTransactions(
            Array.isArray(body.transactions) ? body.transactions : [],
            String(body.externalRef ?? body.payoutId ?? ""),
            fallbackDate,
          );
        } else if (provider === "recurly") {
          parsed = parseRecurlySettlement(
            providerPayload as Parameters<typeof parseRecurlySettlement>[0],
            fallbackDate,
          );
        } else if (provider === "chargebee") {
          parsed = parseChargebeeSettlement(
            providerPayload as Parameters<typeof parseChargebeeSettlement>[0],
            fallbackDate,
          );
        } else {
          return NextResponse.json(
            { error: "unknown provider" },
            { status: 422 },
          );
        }
        if (!parsed.externalRef)
          return NextResponse.json(
            { error: "externalRef required" },
            { status: 422 },
          );
        const result = await importSettlementBatch(orgId, userId, parsed, {
          bankAccountId: body.bankAccountId,
          feeAccountId: body.feeAccountId,
          disputeAccountId: body.disputeAccountId,
          fxAccountId: body.fxAccountId,
          clearingAccountId: body.clearingAccountId,
          subsidiaryId: body.subsidiaryId,
        }, authz.allowedSubsidiaryIds);
        return NextResponse.json({
          ...result,
          totals: summarizeSettlement(parsed.lines),
        });
      }
      case "post": {
        if (!body.batchId)
          return NextResponse.json(
            { error: "batchId required" },
            { status: 422 },
          );
        // A malformed id fails closed exactly like an unresolvable one: the
        // subsidiary lookup below would otherwise surface a Postgres uuid
        // cast error as a 500.
        if (typeof body.batchId !== "string" || !isUuid(body.batchId)) {
          return NextResponse.json({ error: "not found" }, { status: 404 });
        }
        const posted = await postSettlementBatch(orgId, body.batchId, userId, authz.allowedSubsidiaryIds);
        return NextResponse.json(posted);
      }
      case "reverse": {
        if (!body.batchId)
          return NextResponse.json(
            { error: "batchId required" },
            { status: 422 },
          );
        if (!body.reversalDate)
          return NextResponse.json(
            { error: "reversalDate required" },
            { status: 422 },
          );
        // The reversal looks the date's open period up with ::date
        // comparisons: a non-calendar day would otherwise die in Postgres
        // with a raw driver failure, so require a real calendar date first.
        if (!isIsoCalendarDate(body.reversalDate)) {
          return NextResponse.json(
            { error: "reversalDate must be a real calendar date (YYYY-MM-DD)" },
            { status: 422 },
          );
        }
        if (!body.reason)
          return NextResponse.json(
            { error: "reason required" },
            { status: 422 },
          );
        if (typeof body.batchId !== "string" || !isUuid(body.batchId)) {
          return NextResponse.json({ error: "not found" }, { status: 404 });
        }
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
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof ScopeNotFoundError) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (e instanceof UnrestrictedScopeError) {
      return NextResponse.json({ error: "requires unrestricted subsidiary access" }, { status: 403 });
    }
    const status = e instanceof PspSettlementError ? 422 : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status },
    );
  }
}
