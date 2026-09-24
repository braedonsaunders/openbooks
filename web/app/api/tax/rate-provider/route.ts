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
import { z } from "zod";

export const runtime = "nodejs";

const taxRateProviderConfigSchema = z.object({
  provider: z.enum(["avalara", "taxjar", "custom_http", "manual"]),
  displayName: z.string().optional(),
  isEnabled: z.boolean({ error: "isEnabled must be a boolean" }),
  preferProvider: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  apiKey: z.union([z.string().min(1), z.null()], { error: "apiKey must be null or a non-empty string" }).optional(),
  accountId: z.union([z.string().min(1), z.null()], { error: "accountId must be null or a non-empty string" }).optional(),
  licenseKey: z.union([z.string().min(1), z.null()], { error: "licenseKey must be null or a non-empty string" }).optional(),
  expectedUpdatedAt: z.union([z.string().min(1), z.null()], {
    error: "expectedUpdatedAt must be the current revision or null for initial setup",
  }),
});

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
  const parsedBody = await parseJsonBody(req, taxRateProviderConfigSchema, { status: 422 });
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    await saveTaxRateProviderConfig(
      gate.user.orgId,
      {
        provider: body.provider satisfies TaxRateProviderKey,
        displayName: body.displayName,
        isEnabled: body.isEnabled,
        preferProvider: body.preferProvider ?? true,
        settings: body.settings ?? {},
        apiKey: body.apiKey,
        accountId: body.accountId,
        licenseKey: body.licenseKey,
      },
      gate.user.id,
      { expectedUpdatedAt: body.expectedUpdatedAt },
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
