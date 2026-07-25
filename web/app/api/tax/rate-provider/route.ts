import { NextResponse } from "next/server";
import {
  TaxRateProviderError,
  quoteExternalTax,
  quoteFromRate,
  readTaxRateProviderConfigView,
  saveTaxRateProviderConfig,
  type TaxRateProviderKey,
} from "@openbooks/engine/src/tax-rate-providers.ts";
import { guardPermission } from "../../../../lib/authz";

export const runtime = "nodejs";

export async function GET() {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const view = await readTaxRateProviderConfigView(gate.user.orgId);
  return NextResponse.json({ config: view });
}

export async function PUT(req: Request) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const provider = body.provider as TaxRateProviderKey;
  if (!["avalara", "taxjar", "custom_http", "manual"].includes(provider)) {
    return NextResponse.json({ error: "invalid provider" }, { status: 422 });
  }
  try {
    await saveTaxRateProviderConfig(
      gate.user.orgId,
      {
        provider,
        displayName: typeof body.displayName === "string" ? body.displayName : undefined,
        isEnabled: Boolean(body.isEnabled),
        preferProvider: body.preferProvider !== false,
        settings: (body.settings as Record<string, unknown>) ?? {},
        apiKey: "apiKey" in body ? (body.apiKey as string | null) : undefined,
        accountId: "accountId" in body ? (body.accountId as string | null) : undefined,
        licenseKey: "licenseKey" in body ? (body.licenseKey as string | null) : undefined,
      },
      gate.user.id,
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
}

/** Test quote against the configured provider (or manual rate). */
export async function POST(req: Request) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const body = (await req.json().catch(() => ({}))) as Record<string, any>;
  try {
    if (body.action === "manualQuote") {
      const q = quoteFromRate(String(body.taxableAmount ?? "0"), Number(body.ratePercent ?? 0), String(body.jurisdiction ?? "LOCAL"));
      return NextResponse.json(q);
    }
    const result = await quoteExternalTax(
      gate.user.orgId,
      {
        taxableAmount: String(body.taxableAmount ?? "0"),
        currency: body.currency ?? null,
        shipFrom: body.shipFrom ?? {},
        shipTo: body.shipTo ?? {},
        itemCode: body.itemCode ?? null,
        quotedOn: body.quotedOn,
      },
      gate.user.id,
    );
    return NextResponse.json(result);
  } catch (e) {
    const status = e instanceof TaxRateProviderError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
