import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  TaxRateProviderError,
  quoteExternalTax,
  quoteFromRate,
  readTaxRateProviderConfigView,
  saveTaxRateProviderConfig,
  type ProviderDocumentKind,
  type TaxRateProviderKey,
} from "@openbooks/engine/src/tax/rate-providers.ts";
import { guardPermission, guardUnrestrictedScope } from "../../../../lib/authz";
import { canonicalDecimal } from "../../../../lib/exact-decimal";
import { moneyRefusal } from "../../../../lib/payroll-decimal-refusal";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";

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
  // The rate provider prices tax for every entity in the org.
  const unrestricted = guardUnrestrictedScope(gate);
  if (unrestricted) return unrestricted;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>;
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
  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = ((parsedBody2.data));
  try {
    if (body.action === "manualQuote") {
      const taxableAmount = canonicalDecimal(body.taxableAmount ?? "0", 4);
      if (taxableAmount === null) {
        return NextResponse.json({ error: moneyRefusal("Taxable amount", body.taxableAmount ?? "0") }, { status: 422 });
      }
      const ratePercent = canonicalDecimal(body.ratePercent ?? "0", 10);
      if (ratePercent === null) {
        return NextResponse.json({ error: moneyRefusal("Rate percent", body.ratePercent ?? "0", "a rate", 10) }, { status: 422 });
      }
      const q = quoteFromRate(normalizeMoney(taxableAmount), ratePercent, String(body.jurisdiction ?? "LOCAL"));
      return NextResponse.json(q);
    }
    const taxableAmount = canonicalDecimal(body.taxableAmount ?? "0", 4);
    if (taxableAmount === null) {
      return NextResponse.json({ error: moneyRefusal("Taxable amount", body.taxableAmount ?? "0") }, { status: 422 });
    }
    if (body.currency != null && typeof body.currency !== "string") return NextResponse.json({ error: "invalid currency" }, { status: 422 });
    if (body.itemCode != null && typeof body.itemCode !== "string") return NextResponse.json({ error: "invalid item code" }, { status: 422 });
    if (body.quotedOn != null && typeof body.quotedOn !== "string") return NextResponse.json({ error: "invalid quotedOn" }, { status: 422 });
    const documentKinds: ProviderDocumentKind[] = ["customer_invoice", "vendor_bill", "customer_credit", "vendor_credit"];
    const documentKind = typeof body.documentKind === "string" && (documentKinds as string[]).includes(body.documentKind)
      ? (body.documentKind as ProviderDocumentKind)
      : undefined;
    if (body.documentKind != null && documentKind === undefined) {
      return NextResponse.json({ error: "invalid document kind" }, { status: 422 });
    }
    if (body.counterpartyCode != null && (typeof body.counterpartyCode !== "string" || !body.counterpartyCode)) {
      return NextResponse.json({ error: "invalid counterparty code" }, { status: 422 });
    }
    const result = await quoteExternalTax(
      gate.user.orgId,
      {
        taxableAmount: normalizeMoney(taxableAmount),
        currency: typeof body.currency === "string" ? body.currency : null,
        shipFrom: body.shipFrom ?? {},
        shipTo: body.shipTo ?? {},
        itemCode: typeof body.itemCode === "string" ? body.itemCode : null,
        documentKind,
        counterpartyCode: typeof body.counterpartyCode === "string" && body.counterpartyCode ? body.counterpartyCode : undefined,
        quotedOn: typeof body.quotedOn === "string" ? body.quotedOn : undefined,
      },
      gate.user.id,
    );
    return NextResponse.json(result);
  } catch (e) {
    const status = e instanceof TaxRateProviderError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
