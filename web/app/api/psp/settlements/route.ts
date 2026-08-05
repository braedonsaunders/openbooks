import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
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
} from "@openbooks/engine/src/psp-settlement.ts";
import { guardPermission } from "../../../../lib/authz";

export const runtime = "nodejs";

export async function GET() {
  const gate = await guardPermission("banking.read");
  if (gate instanceof NextResponse) return gate;
  const orgId = gate.user.orgId;
  const [batches, configs] = await Promise.all([
    db.execute(sql`
      select id, provider, external_ref as "externalRef", status, currency, net_amount as "netAmount",
             fee_amount as "feeAmount", settlement_date as "settlementDate", journal_entry_id as "journalEntryId",
             reversal_entry_id as "reversalEntryId", reversal_reason as "reversalReason",
             reversed_at as "reversedAt", reversed_by as "reversedBy",
             memo, line_count as "lineCount"
        from psp_settlement_batches where org_id = ${orgId}
       order by settlement_date desc, created_at desc limit 50
    `) as unknown as Promise<{ rows: unknown[] }>,
    db.execute(sql`
      select id, provider, display_name as "displayName", is_enabled as "isEnabled",
             default_bank_account_id as "defaultBankAccountId",
             default_fee_account_id as "defaultFeeAccountId",
             default_clearing_account_id as "defaultClearingAccountId"
        from psp_provider_configs where org_id = ${orgId}
    `) as unknown as Promise<{ rows: unknown[] }>,
  ]);
  return NextResponse.json({ batches: batches.rows, configs: configs.rows });
}

export async function POST(req: Request) {
  const gate = await guardPermission("banking.reconcile");
  if (gate instanceof NextResponse) return gate;
  const orgId = gate.user.orgId;
  const userId = gate.user.id;
  const body = (await req.json().catch(() => ({}))) as Record<string, any>;

  try {
    switch (body.action) {
      case "saveConfig": {
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
        );
        return NextResponse.json({ ok: true });
      }
      case "import": {
        const provider = body.provider as PspProvider;
        let parsed;
        if (provider === "stripe") {
          parsed = parseStripeBalanceTransactions(
            body.transactions ?? [],
            String(body.externalRef ?? body.payoutId ?? ""),
            String(
              body.settlementDate ?? new Date().toISOString().slice(0, 10),
            ),
          );
        } else if (provider === "recurly") {
          parsed = parseRecurlySettlement(body.payload ?? body);
        } else if (provider === "chargebee") {
          parsed = parseChargebeeSettlement(body.payload ?? body);
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
        });
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
        const posted = await postSettlementBatch(orgId, body.batchId, userId);
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
        );
        return NextResponse.json(reversed);
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    const status = e instanceof PspSettlementError ? 422 : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status },
    );
  }
}
