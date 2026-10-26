import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import type { Authz } from "@/lib/authz";
import { LEGAL_FORMS, TAX_CLASSIFICATIONS } from "@openbooks/engine/organization/company-identity";
import {
  readCompanySettings,
  SETTINGS_READ_PERMISSION,
  SETTINGS_WRITE_PERMISSION,
  updateCompanySettings,
} from "@/lib/company-settings";

const requestBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    legalName: z.string().nullable().optional(),
    country: z.string().length(2).optional(),
    baseCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    reportingFramework: z.enum(["us_gaap", "ifrs"]).nullable().optional(),
    taxFramework: z.enum(["asc740", "ias12"]).optional(),
    // Blank or null clears a role; the settings command validates each role by
    // name so a refusal identifies the account mapping to correct.
    controlAccounts: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
    defaultLocale: z.string().optional(),
    timeZone: z.string().nullable().optional(),
    reportPdfStyle: z.enum(["modern", "formal"]).optional(),
    fairValueRangePolicy: z.enum(["warn", "off"]).optional(),
    contractCreation: z.enum(["first_billing", "booking"]).optional(),
    saasMetrics: z
      .object({
        evergreenBookingMonths: z.string().regex(/^[1-9]\d*$/),
        billingsUsePreTaxSubtotal: z.boolean(),
        customerCreditsReduceBillings: z.boolean(),
      })
      .optional(),
    // Cash-sale till defaults; blank or null clears a default and the settings
    // command validates each one by name.
    cashSales: z
      .object({
        walkInCustomerId: z.string().nullable().optional(),
        defaultCashAccountId: z.string().nullable().optional(),
        defaultCardAccountId: z.string().nullable().optional(),
        defaultBankAccountId: z.string().nullable().optional(),
        // Till-drop bank accounts; the settings command validates each by name.
        depositAccountIds: z.array(z.string()).max(50).nullable().optional(),
      })
      .strict()
      .optional(),
    // Company default payment terms; null clears and the settings command
    // validates the referenced terms by name.
    billing: z
      .object({
        defaultPaymentTermsId: z.string().nullable().optional(),
      })
      .optional(),
    // Party-less journal/deposit lines on receivable or payable accounts.
    partylessControlPolicy: z.enum(["warn", "refuse"]).optional(),
    // Legal identity. Shapes here; the jurisdiction rules (identifier formats
    // per country, form/classification pairs) live in updateCompanySettings.
    address: z
      .object({
        line1: z.string().max(200).optional(),
        line2: z.string().max(200).optional(),
        city: z.string().max(200).optional(),
        region: z.string().max(200).optional(),
        postalCode: z.string().max(200).optional(),
        country: z.string().max(2).optional(),
      })
      .strict()
      .nullable()
      .optional(),
    legalForm: z.enum(LEGAL_FORMS).nullable().optional(),
    taxClassification: z.enum(TAX_CLASSIFICATIONS).nullable().optional(),
    taxIds: z.record(z.string(), z.string().max(60).nullable()).optional(),
    // Strict: a field this route does not declare is refused rather than
    // silently dropped while the save reports success.
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided.",
  });

export const runtime = "nodejs";

/**
 * Company & Accounting settings. GET preserves the user-administration view of
 * organization identity, locale, and the two independent accounting policies.
 * PUT persists the complete setup policy: identity, base currency, fiscal
 * calendar, reporting/tax policy, and control accounts.
 *
 * Reads retain the existing user-administration gate because the response is
 * still the company-administration view rather than a posting endpoint.
 * Every write is a setup operation and is separately gated by
 * admin.setup.manage: even an
 * identity-only payload shares one authoritative settings mutation boundary
 * with ledger policy and must never inherit user-administration authority.
 *
 * A fresh organization may change its fiscal-year start month. Once its active
 * default calendar has posted/reversed journals or a non-open period lock, the
 * fiscal foundation is immutable and the transaction refuses the entire PUT.
 */

// The settings read and mutation live in web/lib/company-settings.ts so the
// assistant/MCP `get_company_settings` / `update_company_settings` commands
// are the same operations; this route is the HTTP adapter.

async function legacyGET(gate: Authz) {
  const result = await readCompanySettings(gate.user.orgId);
  if (result.status === 404) return notFound("company settings");
  return NextResponse.json(result.body, { status: result.status });
}

export const GET = defineRoute({
  permission: SETTINGS_READ_PERMISSION,
  feature: {
    none: "Company identity and settings are available independently of optional module features.",
  },
  handler: async ({ authz }) => legacyGET(authz),
});

export const PUT = defineRoute({
  permission: SETTINGS_WRITE_PERMISSION,
  feature: {
    none: "Company identity and settings are available independently of optional module features.",
  },
  scope: "unrestricted",
  body: requestBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {
    const gate = routeAuthz;

    const result = await updateCompanySettings(
      {
        orgId: gate.user.orgId,
        id: gate.user.id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      },
      body as Record<string, unknown>,
    );
    if (result.status === 404) return notFound("company settings");
    return NextResponse.json(result.body, { status: result.status });
  },
});
