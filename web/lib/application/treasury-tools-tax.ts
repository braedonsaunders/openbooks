import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { computeTaxReturn } from "@openbooks/engine/tax-returns/return";
import {
  computeProvisionRun,
  IncomeTaxProvisionError,
  listProvisionRuns,
  orgTaxFramework,
  postProvisionRun,
  type ComputeProvisionOptions,
  type DifferenceInput,
  type PermanentDifference,
} from "@openbooks/engine/tax-returns/income-tax-provision";
import {
  incomeTaxProvisionRunExists,
  listIncomeTaxProvisionFiscalYears,
  listIncomeTaxProvisionRates,
} from "@openbooks/engine/tax-returns/income-tax-provision-queries";
import {
  aggregateTaxReturnAdjustments,
  markTaxFilingFiled,
  normalizeTaxReturnAdjustments,
  prepareTaxFiling,
  TAX_RETURN_ADJUSTMENT_LIMIT,
  TAX_RETURN_ADJUSTMENT_REASON_MAX,
  TaxFilingError,
} from "@openbooks/engine/tax-returns/filing";
import {
  listTaxReturnForms,
  listInstalledTaxReturnFormCodes,
} from "@openbooks/engine/tax-returns/return-queries";
import { filterTaxReturnFormsByFeatures } from "@openbooks/engine/tax-returns/return";
import { installTaxReturnPacks, TAX_RETURN_PACKS } from "@openbooks/engine/tax/seed-tax-forms";
import { planTaxReturnLibraryChange } from "../setup/tax-return-library";
import {
  isTaxProvisionSelection,
  packInstallationStatuses,
  provisionTaxPacks,
} from "@openbooks/engine/tax/pack-provisioning";
import { loadOrgFilingCalendar } from "@openbooks/engine/tax/nexus-ledger";
import {
  retryProviderTransaction,
  TaxProviderCommitError,
  savePartyTaxId,
  validateStoredTaxId,
  listPartyTaxIds,
  readAuthorityConnectionStatus,
  saveAuthorityCredentials,
  verifyAuthorityConnection,
  refreshHmrcToken,
} from "@openbooks/engine/tax";
import { VatValidationError } from "@openbooks/engine/connectors";
import {
  readTaxRateProviderConfigView,
  saveTaxRateProviderConfig,
  TaxRateProviderError,
  type TaxRateProviderKey,
} from "@openbooks/engine/tax/rate-providers";
import { TaxReturnError } from "@openbooks/engine/tax-returns/return";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  assertTreasuryGate,
  assertUnrestricted,
  DATE,
  IDEMPOTENCY_KEY,
  MONEY,
  runOutsideTenantTransaction,
  settleDomainRefusal,
  UUID,
} from "./treasury-tools-common";
import { parseReturnScopeBody, returnScopeOpts } from "../tax-return-scope";
import { TAX_FILING_WRITE_PERMISSION } from "../tax-filing-permission";

function settleTax(error: unknown): never {
  if (
    error instanceof TaxFilingError ||
    error instanceof TaxProviderCommitError ||
    error instanceof TaxRateProviderError ||
    error instanceof TaxReturnError
  )
    settleDomainRefusal({
      message: error.message,
      status: 422,
      code: "code" in error ? error.code : undefined,
      remedy: "remedy" in error ? error.remedy : undefined,
    });
  if (error instanceof IncomeTaxProvisionError) settleDomainRefusal(error, 422);
  if (error instanceof ApplicationError) throw error;
  settleDomainRefusal(error);
}

function validateDate(value: string): void {
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value)
    throw invalidInput(`invalid date ${value}; expected a real YYYY-MM-DD calendar date`);
}

function assertRequestedTaxScope(context: ApplicationContext, subsidiaryIds: readonly string[]) {
  if (subsidiaryIds.length === 0) {
    assertUnrestricted(context);
    return;
  }
  for (const id of subsidiaryIds) {
    if (context.authz.allowedSubsidiaryIds !== null && !context.authz.allowedSubsidiaryIds.has(id))
      throw forbidden("subsidiary.restricted");
  }
}

const filingAdjustmentSchema = z
  .object({
    lineCode: z.string().trim().min(1).max(20).describe("Editable return line code."),
    amount: MONEY.describe("Exact adjustment amount as a decimal string."),
    reason: z
      .string()
      .max(10 * TAX_RETURN_ADJUSTMENT_REASON_MAX)
      .describe("Audit reason for this adjustment."),
  })
  .strict();
const filingInput = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe("Tax return form code from list_tax_return_forms."),
  from: DATE.describe("Start date of the tax reporting period."),
  to: DATE.describe("End date of the tax reporting period."),
  adjustments: z
    .array(filingAdjustmentSchema)
    .max(TAX_RETURN_ADJUSTMENT_LIMIT)
    .optional()
    .describe("Optional reasoned adjustments to editable return lines."),
  filingEntity: z
    .object({
      subsidiaryIds: z
        .array(UUID)
        .max(1000)
        .optional()
        .describe("Subsidiaries included in this filing entity."),
      registrationId: UUID.optional().describe("Tax registration id for the filing entity."),
    })
    .strict()
    .optional()
    .describe("Optional registration and subsidiary scope."),
  translation: z
    .object({
      presentationCurrency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .describe("Currency used to present a consolidated return."),
      rateType: z.string().max(100).optional().describe("Configured exchange rate type."),
      rateDate: DATE.optional().describe("Rate effective date."),
    })
    .strict()
    .optional()
    .describe("Optional consolidated return translation policy."),
});
const hmrcCredentialsInput = z.object({
  clientId: z.string().min(1).max(5000).describe("HMRC developer application client id."),
  clientSecret: z.string().min(1).max(5000).describe("HMRC developer application client secret."),
  scope: z.string().min(1).max(5000).describe("OAuth scope granted to the HMRC application."),
});
const abnCredentialsInput = z.object({
  guid: z.string().min(1).max(5000).describe("ABN Lookup web services GUID."),
});
const saveAuthorityInput = z.object({
  authority: z.enum(["hmrc", "abn"]).describe("Tax authority to configure."),
  credentials: z
    .union([hmrcCredentialsInput, abnCredentialsInput])
    .describe("Credentials for the selected authority, sealed by the tax authority service."),
  idempotencyKey: IDEMPOTENCY_KEY,
});
const provisionDifferenceCategory = z
  .enum(["fixed_assets", "revenue_recognition", "provisions", "loss_carryforward", "other"])
  .describe("Temporary difference category.");
const provisionAmount = (field: string) =>
  z
    .string()
    .regex(
      /^-?0*[0-9]{1,15}(?:\.[0-9]{1,4})?$/,
      `${field} must be an exact decimal with at most 15 significant integer digits and 4 decimal places.`,
    );
const provisionPermanentDifference = z.object({
  description: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("Description of the permanent difference."),
  amount: provisionAmount("amount").describe(
    "Exact permanent difference amount as a decimal string.",
  ),
});
const provisionTemporaryDifference = z.object({
  category: provisionDifferenceCategory,
  description: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("Description of the temporary difference."),
  difference: provisionAmount("difference").describe(
    "Exact temporary difference amount as a decimal string.",
  ),
});
const provisionEntityInput = z.object({
  permanentDifferences: z
    .array(provisionPermanentDifference)
    .max(1000)
    .optional()
    .describe("Entity-specific permanent differences."),
  additionalDifferences: z
    .array(provisionTemporaryDifference)
    .max(1000)
    .optional()
    .describe("Entity-specific temporary differences."),
  lossCarryforwardUsed: provisionAmount("lossCarryforwardUsed")
    .optional()
    .describe("Entity-specific loss carryforward used."),
  valuationAllowance: provisionAmount("valuationAllowance")
    .optional()
    .describe("Entity-specific valuation allowance."),
});
const incomeTaxProvisionInput = z.object({
  fiscalYear: z
    .union([z.number().int(), z.string().regex(/^\d{4}$/)])
    .refine((year) => Number(year) >= 1900 && Number(year) <= 2200, "fiscalYear is required")
    .describe("Fiscal year to measure."),
  permanentDifferences: z
    .array(provisionPermanentDifference)
    .max(1000)
    .optional()
    .describe("Root-entity permanent differences."),
  additionalDifferences: z
    .array(provisionTemporaryDifference)
    .max(1000)
    .optional()
    .describe("Root-entity temporary differences."),
  lossCarryforwardUsed: provisionAmount("lossCarryforwardUsed")
    .optional()
    .describe("Root-entity loss carryforward used."),
  valuationAllowance: provisionAmount("valuationAllowance")
    .optional()
    .describe("Root-entity valuation allowance."),
  entities: z
    .record(UUID, provisionEntityInput)
    .optional()
    .describe("Optional entity-specific inputs keyed by subsidiary id."),
  presentationCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional()
    .describe("Currency for the consolidated view; entity journals remain in functional currency."),
});

async function assertPartyVisible(context: ApplicationContext, partyId: string): Promise<void> {
  if (context.authz.allowedSubsidiaryIds === null) return;
  const row = (
    await db.execute<{ subsidiaryId: string | null }>(
      sql`select subsidiary_id as "subsidiaryId" from parties where org_id=${context.authz.user.orgId} and id=${partyId}`,
      "objects",
    )
  )[0];
  if (
    !row ||
    (row.subsidiaryId !== null && !context.authz.allowedSubsidiaryIds.has(row.subsidiaryId))
  )
    throw notFound("record");
}

const taxHref = (id: string) => `/tax?filing=${encodeURIComponent(id)}`;

export const TREASURY_TAX_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_income_tax_provision_runs",
    title: "List Income Tax Provision Runs",
    description:
      "List provision runs, available fiscal years, enacted rates, and the organization tax framework. Use a returned draft run id to post the provision after reviewing its calculation and source snapshot.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "reports.read"),
    execute: async (context) => {
      await assertTreasuryGate(context, "reports.read");
      const orgId = context.authz.user.orgId;
      const [runs, years, rates, framework] = await Promise.all([
        listProvisionRuns(orgId, context.authz.allowedSubsidiaryIds),
        listIncomeTaxProvisionFiscalYears(orgId),
        listIncomeTaxProvisionRates(orgId, context.authz.allowedSubsidiaryIds),
        orgTaxFramework(orgId),
      ]);
      return {
        runs,
        fiscalYears: years.map((row) => row.fiscal_year),
        rates,
        framework,
        href: "/tax/provisions",
      };
    },
  }),
  definition({
    name: "compute_income_tax_provision",
    title: "Compute Income Tax Provision",
    description:
      "Measure or recompute a draft ASC 740 or IAS 12 provision for a fiscal year using configured rates and exact decimal differences. Use list_income_tax_provision_runs to review source data and existing drafts; posting later requires the source snapshot to remain unchanged.",
    inputSchema: incomeTaxProvisionInput.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "reports.create") && authz.allowedSubsidiaryIds === null,
    execute: async (context, input) => {
      await assertTreasuryGate(context, "reports.create");
      assertUnrestricted(context);
      const source = (
        differences: z.infer<typeof provisionTemporaryDifference>[] | undefined,
      ): DifferenceInput[] => (differences ?? []).map((row) => ({ ...row, source: "manual" }));
      const options: ComputeProvisionOptions = {
        permanentDifferences: input.permanentDifferences as PermanentDifference[] | undefined,
        additionalDifferences: source(input.additionalDifferences),
        lossCarryforwardUsed: input.lossCarryforwardUsed ?? "0",
        valuationAllowance: input.valuationAllowance ?? "0",
        ...(input.entities
          ? {
              entities: Object.fromEntries(
                Object.entries(input.entities).map(([id, entity]) => [
                  id,
                  {
                    permanentDifferences: entity.permanentDifferences as
                      PermanentDifference[] | undefined,
                    additionalDifferences: source(entity.additionalDifferences),
                    lossCarryforwardUsed: entity.lossCarryforwardUsed,
                    valuationAllowance: entity.valuationAllowance,
                  },
                ]),
              ),
            }
          : {}),
        presentationCurrency: input.presentationCurrency,
      };
      try {
        const runId = await computeProvisionRun(
          context.authz.user.orgId,
          Number(input.fiscalYear),
          options,
          context.authz.user.id,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, runId, status: "draft", href: `/tax/provisions?run=${runId}` };
      } catch (error) {
        settleTax(error);
      }
    },
  }),
  definition({
    name: "post_income_tax_provision",
    title: "Post Income Tax Provision",
    description:
      "Post a draft income-tax provision after confirming its source snapshot is still current. Use list_income_tax_provision_runs to find the run id; the service posts balanced journals for the complete organization-wide entity set.",
    inputSchema: z.object({
      runId: UUID.describe("Draft provision run id from list_income_tax_provision_runs."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "gl.post") && authz.allowedSubsidiaryIds === null,
    execute: async (context, input) => {
      await assertTreasuryGate(context, "gl.post");
      assertUnrestricted(context);
      if (!(await incomeTaxProvisionRunExists(context.authz.user.orgId, input.runId))) {
        throw notFound("record");
      }
      try {
        const result = await postProvisionRun(
          context.authz.user.orgId,
          input.runId,
          context.authz.user.id,
        );
        return {
          ok: true,
          runId: input.runId,
          ...result,
          status: "posted",
          href: `/tax/provisions?run=${input.runId}`,
        };
      } catch (error) {
        settleTax(error);
      }
    },
  }),
  definition({
    name: "list_tax_authority_connections",
    title: "List Tax Authority Connections",
    description:
      "Read HMRC and ABN connection readiness, verification time, token expiry, and safe error status. Use this before saving or verifying credentials; secret material is never returned.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context) => {
      await assertTreasuryGate(context, "admin.setup.manage");
      const orgId = context.authz.user.orgId;
      const [hmrc, abn] = await Promise.all([
        readAuthorityConnectionStatus(db, orgId, "hmrc"),
        readAuthorityConnectionStatus(db, orgId, "abn"),
      ]);
      return { connections: [hmrc, abn], href: "/admin/setup?tab=tax" };
    },
  }),
  definition({
    name: "save_tax_authority_credentials",
    title: "Save Tax Authority Credentials",
    description:
      "Save or rotate HMRC VAT API or ABN Lookup credentials sealed at rest. Use list_tax_authority_connections to inspect current readiness; credentials are never returned after saving.",
    inputSchema: saveAuthorityInput,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      await assertTreasuryGate(context, "admin.setup.manage");
      try {
        const credentials =
          input.authority === "hmrc"
            ? hmrcCredentialsInput.safeParse(input.credentials)
            : abnCredentialsInput.safeParse(input.credentials);
        if (!credentials.success) {
          throw invalidInput(
            input.authority === "hmrc"
              ? "HMRC credentials need clientId, clientSecret and scope from the HMRC developer hub"
              : "ABN credentials need the GUID from ABN Lookup web services",
          );
        }
        const connection = await saveAuthorityCredentials(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.authority,
          credentials.data,
        );
        return {
          ok: true,
          connection,
          status: connection.status,
          href: "/admin/setup?tab=tax",
        };
      } catch (error) {
        settleTax(error);
      }
    },
  }),
  definition({
    name: "verify_tax_authority_connection",
    title: "Verify Tax Authority Connection",
    description:
      "Perform a live HMRC or ABN connection check and persist the resulting connection status. Use list_tax_authority_connections to confirm credentials are configured and review the updated verification state.",
    inputSchema: z.object({
      authority: z.enum(["hmrc", "abn"]).describe("Configured tax authority to verify."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      await assertTreasuryGate(context, "admin.setup.manage");
      try {
        const connection = await runOutsideTenantTransaction(context, () =>
          verifyAuthorityConnection(
            db,
            context.authz.user.orgId,
            context.authz.user.id,
            input.authority,
          ),
        );
        return {
          ok: true,
          connection,
          status: connection.status,
          href: "/admin/setup?tab=tax",
        };
      } catch (error) {
        settleTax(error);
      }
    },
  }),
  definition({
    name: "refresh_hmrc_tax_token",
    title: "Refresh HMRC Tax Token",
    description:
      "Exchange the configured HMRC client credentials for a fresh access token and persist its expiry. Use list_tax_authority_connections to review HMRC readiness before and after the request.",
    inputSchema: z.object({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context) => {
      await assertTreasuryGate(context, "admin.setup.manage");
      try {
        const connection = await runOutsideTenantTransaction(context, () =>
          refreshHmrcToken(db, context.authz.user.orgId, context.authz.user.id),
        );
        return {
          ok: true,
          connection,
          status: connection.status,
          href: "/admin/setup?tab=tax",
        };
      } catch (error) {
        settleTax(error);
      }
    },
  }),
  definition({
    name: "get_tax_rate_provider_config",
    title: "Get Tax Rate Provider Configuration",
    description:
      "Read the active tax provider selection, credential-presence flags, and configuration revision before setup changes or a provider quote. Secret values are never returned.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context) => {
      await assertTreasuryGate(context, "admin.setup.manage");
      return {
        config: await readTaxRateProviderConfigView(context.authz.user.orgId),
        href: "/admin/setup?tab=tax",
      };
    },
  }),
  definition({
    name: "prepare_tax_filing_snapshot",
    title: "Prepare Tax Filing Snapshot",
    description:
      "Recompute and freeze a versioned statutory tax return snapshot for a registered form and closed reporting range. Use list_tax_return_forms and tax_return to verify the form and period; an organization-wide return requires unrestricted access.",
    inputSchema: filingInput.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, TAX_FILING_WRITE_PERMISSION),
    execute: async (context, input) => {
      assertApplicationPermission(context, TAX_FILING_WRITE_PERMISSION);
      validateDate(input.from);
      validateDate(input.to);
      if (input.from > input.to) throw invalidInput("invalid period");
      const parsed = parseReturnScopeBody({
        filingEntity: input.filingEntity,
        translation: input.translation,
      });
      if (parsed.error || !parsed.scope) throw invalidInput(parsed.error ?? "invalid scope");
      assertRequestedTaxScope(context, parsed.scope.subsidiaryIds);
      try {
        const entries = normalizeTaxReturnAdjustments(input.adjustments ?? []);
        const result = await computeTaxReturn(
          context.authz.user.orgId,
          input.code,
          input.from,
          input.to,
          aggregateTaxReturnAdjustments(entries),
          returnScopeOpts(parsed.scope),
        );
        const filing = await prepareTaxFiling(
          context.authz.user.orgId,
          context.authz.user.id,
          result,
          entries,
        );
        return {
          ok: true,
          ...filing,
          status: "prepared",
          formCode: result.formCode,
          from: result.from,
          to: result.to,
          href: taxHref(filing.id),
        };
      } catch (error) {
        settleTax(error);
      }
    },
  }),
  definition({
    name: "file_tax_filing_snapshot",
    title: "File Tax Filing Snapshot",
    description:
      "Record the authority filing reference and transition a current prepared tax snapshot to filed. The action is organization-wide; use the prepared filing id from prepare_tax_filing_snapshot and retain the authority receipt.",
    inputSchema: z.object({
      filingId: UUID.describe("Prepared tax filing id returned by prepare_tax_filing_snapshot."),
      filingReference: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe("Government filing or receipt reference."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) =>
      can(authz, TAX_FILING_WRITE_PERMISSION) && authz.allowedSubsidiaryIds === null,
    execute: async (context, input) => {
      await assertTreasuryGate(context, TAX_FILING_WRITE_PERMISSION);
      assertUnrestricted(context);
      try {
        const result = await markTaxFilingFiled(
          context.authz.user.orgId,
          input.filingId,
          context.authz.user.id,
          input.filingReference?.trim() || null,
        );
        return {
          ok: true,
          filingId: result.id,
          filedAt: result.filedAt,
          status: "filed",
          href: taxHref(result.id),
        };
      } catch (error) {
        settleTax(error);
      }
    },
  }),
  definition({
    name: "list_tax_filing_obligations",
    title: "List Tax Filing Obligations",
    description:
      "List the organization's tax registrations and filing obligations for a real calendar date range. Use list_tax_return_forms and tax_return to inspect a form before preparing its filing snapshot.",
    inputSchema: z.object({
      from: DATE.describe("First date in the obligation range."),
      to: DATE.describe("Last date in the obligation range."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "reports.read") && authz.allowedSubsidiaryIds === null,
    execute: async (context, input) => {
      await assertTreasuryGate(context, "reports.read");
      assertUnrestricted(context);
      validateDate(input.from);
      validateDate(input.to);
      if (input.from > input.to) throw invalidInput("invalid period");
      return {
        from: input.from,
        to: input.to,
        obligations: await loadOrgFilingCalendar(context.authz.user.orgId, input.from, input.to),
      };
    },
  }),
  definition({
    name: "install_tax_return_packs",
    title: "Install Tax Return Packs",
    description:
      "Install or explicitly reset reference tax return form packs for the organization. Review list_tax_return_forms first; the operation rewrites an organization-wide library and requires unrestricted setup access.",
    inputSchema: z.object({
      mode: z
        .enum(["install", "reset"])
        .describe("Install missing packs or reset the selected packs."),
      packs: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(25)
        .describe("Tax return form pack codes from supported forms."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage") && authz.allowedSubsidiaryIds === null,
    execute: async (context, input) => {
      await assertTreasuryGate(context, "admin.setup.manage");
      assertUnrestricted(context);
      const installed = await listInstalledTaxReturnFormCodes(context.authz.user.orgId);
      const plan = planTaxReturnLibraryChange(
        input,
        new Set(TAX_RETURN_PACKS.map((pack) => pack.code)),
        new Set(installed.map((row) => row.code)),
      );
      if ("error" in plan) throw invalidInput(plan.error);
      const results = plan.targets.length
        ? await installTaxReturnPacks(context.authz.user.orgId, plan.targets, context.authz.user.id)
        : [];
      const forms = await filterTaxReturnFormsByFeatures(
        context.authz.user.orgId,
        await listTaxReturnForms(context.authz.user.orgId),
      );
      return {
        ok: true,
        installed: input.mode === "install" ? results.map((row) => row.code) : [],
        reset: input.mode === "reset" ? results.map((row) => row.code) : [],
        skipped: plan.skipped,
        forms,
      };
    },
  }),
  definition({
    name: "provision_tax_packs",
    title: "Provision Tax Packs",
    description:
      "Provision the jurisdiction, tax codes and rates, return form, and nexus setup for selected supported country or state packs. Check packInstallationStatuses first; the write changes organization-wide tax configuration.",
    inputSchema: z.object({
      packs: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(60)
        .describe("Tax pack selections returned by the native tax setup surface."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage") && authz.allowedSubsidiaryIds === null,
    execute: async (context, input) => {
      await assertTreasuryGate(context, "admin.setup.manage");
      assertUnrestricted(context);
      if (input.packs.some((code) => !isTaxProvisionSelection(code)))
        throw invalidInput("unknown tax setup selection");
      try {
        const result = await provisionTaxPacks(
          context.authz.user.orgId,
          input.packs,
          context.authz.user.id,
        );
        return { ok: true, ...result, href: "/admin/setup?tab=tax" };
      } catch (error) {
        settleTax(error);
      }
    },
  }),
  definition({
    name: "list_tax_pack_installations",
    title: "List Tax Pack Installations",
    description:
      "Read installed country tax pack versions and checksum drift before provisioning or resetting tax setup. This read requires reports.read and returns only the caller's organization state.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "reports.read"),
    execute: async (context) => {
      await assertTreasuryGate(context, "reports.read");
      return { packs: await packInstallationStatuses(context.authz.user.orgId) };
    },
  }),
  definition({
    name: "save_tax_rate_provider_config",
    title: "Save Tax Rate Provider Configuration",
    description:
      "Create or update a revision-checked external tax provider configuration, including its enabled and commit settings. Use the current expectedUpdatedAt from the tax provider configuration read; credentials are accepted only through this secure setup action.",
    inputSchema: z.object({
      provider: z
        .enum(["avalara", "taxjar", "custom_http", "manual"])
        .describe("Supported tax provider."),
      displayName: z.string().max(200).optional().describe("Operator-visible provider name."),
      isEnabled: z.boolean().describe("Whether the provider may be used for quotes."),
      preferProvider: z
        .boolean()
        .optional()
        .describe("Whether provider quotes take precedence over native rates."),
      commitTransactions: z
        .boolean()
        .optional()
        .describe("Whether posted documents are committed to the provider."),
      settings: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Provider-specific settings required by the selected adapter."),
      apiKey: z
        .string()
        .min(1)
        .max(4096)
        .nullable()
        .optional()
        .describe("API key for the provider, when required."),
      accountId: z
        .string()
        .min(1)
        .max(4096)
        .nullable()
        .optional()
        .describe("Provider account id, when required."),
      licenseKey: z
        .string()
        .min(1)
        .max(4096)
        .nullable()
        .optional()
        .describe("Provider license key, when required."),
      expectedUpdatedAt: z
        .string()
        .max(64)
        .regex(/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/)
        .nullable()
        .describe("Current configuration revision, or null only during initial setup."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage") && authz.allowedSubsidiaryIds === null,
    execute: async (context, input) => {
      await assertTreasuryGate(context, "admin.setup.manage");
      assertUnrestricted(context);
      try {
        await saveTaxRateProviderConfig(
          context.authz.user.orgId,
          {
            provider: input.provider satisfies TaxRateProviderKey,
            displayName: input.displayName,
            isEnabled: input.isEnabled,
            preferProvider: input.preferProvider ?? true,
            commitTransactions: input.commitTransactions,
            settings: (input.settings ?? {}) as Record<string, unknown>,
            apiKey: input.apiKey,
            accountId: input.accountId,
            licenseKey: input.licenseKey,
          },
          context.authz.user.id,
          { expectedUpdatedAt: input.expectedUpdatedAt },
        );
        return {
          ok: true,
          config: await readTaxRateProviderConfigView(context.authz.user.orgId),
          href: "/admin/setup?tab=tax",
        };
      } catch (error) {
        settleTax(error);
      }
    },
  }),
  definition({
    name: "add_party_tax_id",
    title: "Add Party Tax ID",
    description:
      "Record a normalized VAT, HMRC, ABN, or GST registration for a customer or supplier. Use find_parties to identify the party and verify its subsidiary scope before validation.",
    inputSchema: z.object({
      partyId: UUID.describe("Customer or supplier party id from find_parties."),
      scheme: z.enum(["vies", "hmrc", "abn", "gst"]).describe("Tax authority scheme."),
      value: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .describe("Tax registration number as supplied by the party."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "parties.manage"),
    featureKey: "crossBorderTax",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "parties.manage", "crossBorderTax");
      await assertPartyVisible(context, input.partyId);
      try {
        const result = await savePartyTaxId(
          db,
          context.authz.user.orgId,
          { partyId: input.partyId, scheme: input.scheme, value: input.value },
          context.authz.user.id,
        );
        return {
          ok: true,
          ...result,
          status: "recorded",
          href: `/parties/${encodeURIComponent(input.partyId)}`,
        };
      } catch (error) {
        settleTax(error);
      }
    },
  }),
  definition({
    name: "list_party_tax_ids",
    title: "List Party Tax IDs",
    description:
      "Read stored tax authority identifiers and validation status for a visible customer or supplier. Use a party id from find_parties; the cross-border tax feature must be enabled.",
    inputSchema: z.object({ partyId: UUID.describe("Party id from find_parties.") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "parties.read"),
    featureKey: "crossBorderTax",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "parties.read", "crossBorderTax");
      await assertPartyVisible(context, input.partyId);
      return { taxIds: await listPartyTaxIds(db, context.authz.user.orgId, input.partyId) };
    },
  }),
  definition({
    name: "validate_party_tax_id",
    title: "Validate Party Tax ID",
    description:
      "Ask the configured tax authority to validate a stored party tax number and persist its confirmed verdict. Use list_party_tax_ids to obtain the id; the authority is contacted and an outage remains an actionable refusal.",
    inputSchema: z.object({
      taxIdId: UUID.describe("Stored party tax id from list_party_tax_ids."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "parties.manage"),
    featureKey: "crossBorderTax",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "parties.manage", "crossBorderTax");
      try {
        const result = await runOutsideTenantTransaction(context, () =>
          validateStoredTaxId(context.authz.user.orgId, input.taxIdId, context.authz.user.id),
        );
        return { ok: true, ...result, status: "validated", href: "/customers" };
      } catch (error) {
        if (error instanceof VatValidationError)
          throw invalidInput(
            "the tax authority could not confirm this number; check the number and retry the validation",
          );
        settleTax(error);
      }
    },
  }),
  definition({
    name: "retry_tax_provider_transaction",
    title: "Retry Tax Provider Transaction",
    description:
      "Rearm one terminally failed provider commit for the scheduled retry scan. Use the tax provider transaction record id; committed, voided, or pending transactions refuse, and the write requires unrestricted compliance access.",
    inputSchema: z.object({
      transactionId: UUID.describe(
        "Failed provider transaction id from tax provider transaction history.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "compliance.file") && authz.allowedSubsidiaryIds === null,
    execute: async (context, input) => {
      await assertTreasuryGate(context, "compliance.file");
      assertUnrestricted(context);
      try {
        await retryProviderTransaction(
          context.authz.user.orgId,
          input.transactionId,
          context.authz.user.id,
        );
        return { ok: true, transactionId: input.transactionId, status: "queued", href: "/tax" };
      } catch (error) {
        settleTax(error);
      }
    },
  }),
];
