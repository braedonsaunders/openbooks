import { quoteGoodsPlaceOfSupply, PlaceOfSupplyError } from '@openbooks/engine/tax';
import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
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
import { guardUnrestrictedScope } from "../../../../lib/authz";
import { canonicalDecimal } from "../../../../lib/exact-decimal";
import { moneyRefusal } from "../../../../lib/payroll-decimal-refusal";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import { z } from "zod";

export const runtime = "nodejs";

const addressSchema = z.object({
  line1: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  postalCode: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
}).strict();
const quoteFields = {
  taxableAmount: z.string(),
  ratePercent: z.string().optional(),
  jurisdiction: z.string().optional(),
  currency: z.string().nullable().optional(),
  itemCode: z.string().nullable().optional(),
  quotedOn: z.string().nullable().optional(),
  documentKind: z.enum(["customer_invoice", "vendor_bill", "customer_credit", "vendor_credit"]).nullable().optional(),
  counterpartyCode: z.string().nullable().optional(),
  shipFrom: addressSchema.optional(),
  shipTo: addressSchema.optional(),
};
const bodyObjectSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("nativeGoodsQuote"), taxableAmount: z.string(), quotedOn: z.string(),
    country: z.literal("CA"), deliveryProvince: z.string(), basis: z.literal("ordinary_taxable_goods_sale"),
  }).strict(),
  z.object({
    action: z.literal("manualQuote"),
    ...quoteFields,
    ratePercent: z.string(),
    jurisdiction: z.string().min(1),
  }).strict(),
  z.object({
    action: z.literal("providerQuote"),
    ...quoteFields,
  }).strict(),
]);

const taxRateProviderConfigSchema = z.object({
  provider: z.enum(["avalara", "taxjar", "custom_http", "manual"]),
  displayName: z.string().optional(),
  isEnabled: z.boolean({ error: "isEnabled must be a boolean" }),
  preferProvider: z.boolean().optional(),
  commitTransactions: z.boolean({ error: "commitTransactions must be a boolean" }).optional(),
  // Provider-specific settings are a JSONB column interpreted by the selected provider.
  settings: z.record(z.string(), z.json()).optional(),
  apiKey: z.union([z.string().min(1), z.null()], { error: "apiKey must be null or a non-empty string" }).optional(),
  accountId: z.union([z.string().min(1), z.null()], { error: "accountId must be null or a non-empty string" }).optional(),
  licenseKey: z.union([z.string().min(1), z.null()], { error: "licenseKey must be null or a non-empty string" }).optional(),
  expectedUpdatedAt: z.union([z.string().min(1), z.null()], {
    error: "expectedUpdatedAt must be the current revision or null for initial setup",
  }),
});

async function legacyGET(request: Request, ctx: { params: Promise<unknown> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;

  const view = await readTaxRateProviderConfigView(gate.user.orgId);
  return NextResponse.json({ config: view });
}

async function legacyPUT(req: Request, ctx: { params: Promise<unknown> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;

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
        commitTransactions: body.commitTransactions,
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
    return apiErrorResponse(e, { safeStatus: 422 });
  }
}

/** Test quote against the configured provider (or manual rate). */
async function legacyPOST(req: Request, ctx: { params: Promise<unknown> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;

  const parsedBody2 = await parseJsonBody(req, bodyObjectSchema);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = ((parsedBody2.data));
  try {
    if (body.action === "nativeGoodsQuote") return NextResponse.json(quoteGoodsPlaceOfSupply(body));
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
    return apiErrorResponse(e, e instanceof TaxRateProviderError || e instanceof PlaceOfSupplyError ? { safeStatus: 422 } : {})
  }
}

export const GET = defineRoute({
  permission: "admin.setup.manage", feature: { none: "This route is governed by its permission and service authorization." },

  handler: ({ request, params, authz }) => legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const PUT = defineRoute({
  permission: "admin.setup.manage", feature: { none: "This route is governed by its permission and service authorization." },

  handler: ({ request, params, authz }) => legacyPUT(request, { params: Promise.resolve(params) }, authz),
});

export const POST = defineRoute({
  permission: "admin.setup.manage", feature: { none: "This route is governed by its permission and service authorization." },

  handler: ({ request, params, authz }) => legacyPOST(request, { params: Promise.resolve(params) }, authz),
});
