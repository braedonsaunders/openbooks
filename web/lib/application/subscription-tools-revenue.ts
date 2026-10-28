import "server-only";
import { z } from "zod";
import {
  capitalizeContractCost,
  importCommissionCosts,
  linkContractCostAsset,
  proposeExpectedBreakage,
  breakageGrantOptions,
  recognizeContractCostImpairment,
  runContractCostAmortization,
} from "@openbooks/engine/revenue";
import { controlRecognition } from "@openbooks/engine/revenue/recognition-controls";
import {
  cancelRevenueRecognitionForInvoice,
  cancellationDocumentScope,
} from "@openbooks/engine/ledger/revenue-recognition-cancellation";
import {
  getContractPricingSubsidiary,
  setContractPricing,
} from "@openbooks/engine/revenue/recognition-transaction-price";
import { proposeRevenueModification } from "@openbooks/engine/revenue/contract-modifications";
import { reconcileLegacyObligation } from "@openbooks/engine/revenue/recognition";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { parseCostAmountMinor } from "@/lib/contract-costs";
import { isDocKindEnabled } from "@/lib/documents";
import { canonicalDecimal } from "@/lib/exact-decimal";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { normalizeMoney } from "@openbooks/engine/money";
import { assertSubsidiaryAccess } from "./context";
import { ApplicationError } from "./errors";
import { readEntityListPage } from "@/lib/list/entity-reader";
import { DATE, IDEMPOTENCY_KEY, mutationTool, readTool, UUID } from "./subscription-tools-shared";
import {
  executeRevenueRecognitionRun,
  buildRevenueRecognitionPreview,
} from "@/lib/revenue/recognition-actions";
import { revenueRecognitionCandidates, loadContract } from "@/app/(app)/revenue/_lib";
import type { ApplicationToolDefinition } from "./tool-definition";

const COST_SOURCE = z.enum(["manual", "import", "payroll_earning", "vendor_bill"]);
const exactMoneyText = z
  .string()
  .max(40)
  .regex(/^-?\d{1,15}(?:\.\d{1,4})?$/)
  .describe("Exact decimal amount; never a JSON number.");
const modificationMoney = exactMoneyText;
const revenueDate = z
  .string()
  .max(10)
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isIsoCalendarDate)
  .describe("Valid calendar date in YYYY-MM-DD format.");
const modificationRate = z
  .string()
  .max(40)
  .regex(/^\d{1,10}(?:\.\d{1,10})?$/)
  .describe("Exact decimal exchange rate.");
const modificationPromise = z.object({
  existingId: UUID.optional().describe(
    "Existing performance obligation id for a retained promise.",
  ),
  description: z.string().trim().min(1).max(1000).describe("Distinct promised good or service."),
  standaloneSellingPrice: modificationMoney.describe(
    "Standalone selling price in exact decimal form.",
  ),
  recognitionRuleId: UUID.describe("Recognition rule id from setup reads."),
  recognitionEndsOn: DATE.nullable().optional().describe("Optional final recognition date."),
  percentComplete: modificationMoney.describe("Progress percentage as an exact decimal string."),
  deferredAccountId: UUID.describe("Deferred revenue account id."),
  recognizedAccountId: UUID.describe("Earned revenue account id."),
  events: z
    .array(
      z.object({
        periodMonth: revenueDate,
        amount: modificationMoney.describe("Exact decimal recognition amount."),
        description: z.string().max(1000).describe("Recognition event explanation."),
      }),
    )
    .max(1200)
    .optional()
    .describe("Optional dated recognition events for event-based promises."),
});
const modificationGroup = z.object({
  treatment: z
    .enum(["separate", "prospective", "catch_up"])
    .describe("Accounting treatment for this modification group."),
  existingObligationIds: z
    .array(UUID)
    .max(500)
    .describe("Existing obligations affected by this group."),
  considerationChange: modificationMoney.describe("Signed exact decimal change in consideration."),
  remainingDistinct: z.boolean().describe("Whether the remaining goods or services are distinct."),
  additionsAtStandalonePrice: z
    .boolean()
    .describe("Whether added promises are priced at standalone selling price."),
  promises: z
    .array(modificationPromise)
    .min(1)
    .max(500)
    .describe("Promises included in this modification group."),
});
const revenueModification = z.object({
  effectiveOn: revenueDate,
  reason: z.string().trim().min(8).max(1000).describe("Audit reason for the modification."),
  idempotencyKey: IDEMPOTENCY_KEY,
  subsidiaryId: UUID.describe("Subsidiary that owns the revenue contract."),
  enforceableRightsEvidence: z
    .string()
    .trim()
    .min(8)
    .max(4000)
    .describe("Evidence of enforceable contractual rights."),
  assessment: z
    .string()
    .trim()
    .min(8)
    .max(4000)
    .describe("Accounting assessment supporting the modification treatment."),
  bookRates: z
    .array(z.object({ bookId: UUID, fxRate: modificationRate }))
    .min(1)
    .max(100)
    .describe("Book-specific exchange rates effective for this modification."),
  groups: z
    .array(modificationGroup)
    .min(1)
    .max(100)
    .describe("Modification groups and their consideration allocation."),
});

const pricingVariable = z
  .object({
    method: z
      .enum(["expected_value", "most_likely_amount"])
      .describe("Variable consideration estimation method."),
    outcomes: z
      .array(
        z.object({
          amount: exactMoneyText.describe("Exact decimal outcome amount."),
          probabilityPercent: z
            .string()
            .max(40)
            .regex(/^\d{1,3}(?:\.\d{1,4})?$/)
            .describe("Exact decimal probability percentage."),
        }),
      )
      .min(1)
      .max(100)
      .describe("Possible outcomes and their probabilities."),
    constraintLimit: exactMoneyText
      .nullable()
      .optional()
      .describe("Optional exact decimal constraint limit."),
  })
  .nullable()
  .optional()
  .describe("Optional variable consideration estimate.");

export const SUBSCRIPTION_REVENUE_TOOLS: ApplicationToolDefinition[] = [
  readTool({
    name: "list_contract_cost_assets",
    title: "List Contract Cost Assets",
    description:
      "List capitalized commission and fulfillment assets with balances and amortization status. Use returned asset ids with impair_contract_cost_asset and link_contract_cost_asset.",
    permission: "contract_costs.read",
    featureKey: "contractCosts",
    inputSchema: z.object({
      search: z
        .string()
        .max(200)
        .optional()
        .describe("Optional contract, customer or cost search."),
      page: z.number().int().min(1).max(10000).optional().describe("One-based result page."),
      perPage: z.number().int().min(5).max(100).optional().describe("Rows per page."),
    }),
    execute: async (context, input) => {
      const result = await readEntityListPage({
        recordType: "contract_cost_asset",
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        q: input.search,
        page: input.page,
        perPage: input.perPage,
      });
      if (!result.ok) {
        const status =
          result.error === "forbidden"
            ? 403
            : result.error === "feature_disabled" || result.error === "unknown_record_type"
              ? 404
              : result.error === "stale_scope"
                ? 409
                : 422;
        const code =
          status === 403
            ? "forbidden"
            : status === 404
              ? "not_found"
              : status === 409
                ? "conflict"
                : "invalid_input";
        throw new ApplicationError(code, result.error, status, {
          remedy: result.remedy,
          ...(result.field ? { field: result.field } : {}),
        });
      }
      return { ok: true, ...result, href: "/revenue/contract-costs?view=assets" };
    },
  }),
  readTool({
    name: "list_revenue_recognition_candidates",
    title: "List Revenue Recognition Candidates",
    description:
      "List contracts and obligations with unposted recognition lines for a run. Use these ids with preview_revenue_recognition and get_revenue_contract.",
    permission: "ar.read",
    featureKey: "revenueRecognition",
    inputSchema: z.object({}),
    execute: async (context) => ({
      ok: true,
      candidates: await revenueRecognitionCandidates(
        context.authz.user.orgId,
        context.authz.allowedSubsidiaryIds,
      ),
      href: "/revenue",
    }),
  }),
  readTool({
    name: "get_revenue_contract",
    title: "Get Revenue Contract",
    description:
      "Read a revenue contract, its obligations, billed documents and recognition schedules. Find contract ids with list_revenue_recognition_candidates or the revenue contract list.",
    permission: "ar.read",
    featureKey: "revenueRecognition",
    inputSchema: z.object({ contractId: UUID }),
    execute: async (context, input) => {
      const contract = await loadContract(
        input.contractId,
        context.authz.user.orgId,
        context.authz.allowedSubsidiaryIds,
        "en",
      );
      if (!contract) throw new ApplicationError("not_found", "revenue contract not found", 404);
      contract.prepaidGrants = await breakageGrantOptions(
        context.authz.user.orgId,
        context.authz.user.id,
        input.contractId,
      );
      return { ok: true, contract, href: `/revenue?contract=${input.contractId}` };
    },
  }),
  mutationTool({
    name: "propose_expected_breakage",
    title: "Propose Expected Breakage",
    description:
      "Record an evidenced expected-breakage assessment for a prepaid grant after evaluating the applicable reversal constraint. Find grant and contract ids with the revenue contract drawer.",
    permission: "ar.post",
    featureKey: "revenueRecognition",
    inputSchema: z.object({
      grantId: UUID,
      effectiveOn: revenueDate,
      reason: z.string().trim().min(8).max(1000).describe("Reason for the assessment."),
      estimate: z
        .object({
          method: z
            .enum(["expected_proportional", "remaining_use_remote"])
            .describe("Breakage estimate method."),
          expectedBreakage: exactMoneyText.describe("Exact decimal breakage estimate."),
          entitled: z.boolean().describe("Whether the entity is entitled to the estimated amount."),
          meetsReversalConstraint: z
            .boolean()
            .describe("Whether reversal constraint criteria are met."),
          thirdPartyObligation: z
            .boolean()
            .describe("Whether another party is entitled to a portion."),
          evidence: z
            .string()
            .trim()
            .min(40)
            .max(10000)
            .describe("Assessment evidence and support."),
        })
        .describe("Breakage estimation evidence and amount."),
      idempotencyKey: z
        .string()
        .min(1)
        .max(120)
        .describe("Retry key for this breakage assessment."),
    }),
    execute: async (context, input) => {
      const id = await proposeExpectedBreakage(context.authz.user.orgId, context.authz.user.id, {
        ...input,
        estimate: {
          ...input.estimate,
          expectedBreakage: normalizeMoney(canonicalDecimal(input.estimate.expectedBreakage, 4)!),
        },
      });
      return { ok: true, id, href: `/revenue?contract=${input.grantId}` };
    },
  }),
  mutationTool({
    name: "cancel_revenue_recognition",
    title: "Cancel Revenue Recognition",
    description:
      "Reverse the recognition journals for an invoice and send the invoice through the controlled void workflow. Find invoice ids with document reads; the invoice must be in a voidable state.",
    permission: "ar.post",
    featureKey: "revenueRecognition",
    destructive: true,
    inputSchema: z.object({
      documentId: UUID,
      reason: z.string().trim().min(5).max(500).describe("Audit reason for the cancellation."),
      reversalDate: DATE.optional(),
      idempotencyKey: z
        .string()
        .min(1)
        .max(120)
        .describe("Retry key for this revenue-recognition cancellation."),
    }),
    execute: async (context, input) => {
      const user = context.authz.user;
      const document = await cancellationDocumentScope(user.orgId, input.documentId);
      if (!document || !(await isDocKindEnabled(user.orgId, document.kind)))
        throw new ApplicationError("not_found", "record not found", 404);
      assertSubsidiaryAccess(context, document.subsidiaryId);
      const result = await cancelRevenueRecognitionForInvoice({
        documentId: input.documentId,
        orgId: user.orgId,
        actorId: user.id,
        reason: input.reason,
        reversalDate: input.reversalDate ?? (await businessToday(user.orgId)),
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
      });
      return { ok: true, ...result, href: `/invoices?invoice=${input.documentId}` };
    },
  }),
  mutationTool({
    name: "capitalize_contract_cost",
    title: "Capitalize Contract Cost",
    description:
      "Capitalize an eligible commission or fulfillment cost under the active contract-cost policy. Find contract, party and account ids with the revenue contract, party and account reads.",
    permission: "contract_costs.manage",
    featureKey: "contractCosts",
    inputSchema: z.object({
      revenueContractId: UUID.optional(),
      repPartyId: UUID.optional(),
      customerPartyId: UUID.optional(),
      costType: z
        .enum(["commission", "fulfilment"])
        .optional()
        .describe("Cost category; defaults to commission."),
      amount: exactMoneyText,
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .describe("Uppercase ISO 4217 currency code."),
      capitalizedOn: DATE,
      method: z.enum(["straight_line", "pattern"]).optional().describe("Amortization method."),
      originalExpenseAccountId: UUID,
      renewalCommission: exactMoneyText
        .nullable()
        .optional()
        .describe("Optional exact decimal renewal commission amount."),
      sourceKind: COST_SOURCE.optional().describe("Source document type; defaults to manual."),
      sourceRef: z.string().max(200).optional().describe("Optional source reference."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      const result = await capitalizeContractCost({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        revenueContractId: body.revenueContractId,
        repPartyId: body.repPartyId,
        customerPartyId: body.customerPartyId,
        costType: body.costType ?? "commission",
        amountMinor: await parseCostAmountMinor(
          context.authz.user.orgId,
          body.amount,
          body.currency,
        ),
        currency: body.currency,
        capitalizedOn: body.capitalizedOn,
        method: body.method,
        originalExpenseAccountId: body.originalExpenseAccountId,
        renewalCommissionMinor: body.renewalCommission
          ? await parseCostAmountMinor(
              context.authz.user.orgId,
              body.renewalCommission,
              body.currency,
              { allowZero: true },
            )
          : undefined,
        source: { kind: body.sourceKind ?? "manual", ref: body.sourceRef ?? null },
      });
      return { ok: true, ...result, href: "/revenue/contract-costs" };
    },
  }),
  mutationTool({
    name: "impair_contract_cost_asset",
    title: "Impair Contract Cost Asset",
    description:
      "Recognize impairment for a capitalized contract-cost asset when its carrying amount exceeds recoverable consideration. Find asset ids with the contract-cost workspace; requires contract-cost approval permission.",
    permission: "contract_costs.approve",
    featureKey: "contractCosts",
    inputSchema: z.object({
      assetId: UUID,
      remainingConsideration: exactMoneyText.describe("Exact decimal recoverable consideration."),
      costsNotYetRecognized: exactMoneyText
        .nullable()
        .optional()
        .describe("Exact decimal costs not yet recognized."),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .describe("Uppercase ISO 4217 currency code."),
      reason: z.string().min(8).max(2000).describe("Impairment assessment evidence."),
      assessedOn: DATE,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const result = await recognizeContractCostImpairment({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        assetId: input.assetId,
        remainingConsiderationMinor: await parseCostAmountMinor(
          context.authz.user.orgId,
          input.remainingConsideration,
          input.currency,
          { allowZero: true },
        ),
        costsNotYetRecognizedMinor: input.costsNotYetRecognized
          ? await parseCostAmountMinor(
              context.authz.user.orgId,
              input.costsNotYetRecognized,
              input.currency,
              { allowZero: true },
            )
          : 0n,
        reason: input.reason,
        assessedOn: input.assessedOn,
      });
      return { ok: true, ...result, href: "/revenue/contract-costs" };
    },
  }),
  mutationTool({
    name: "import_contract_commission_costs",
    title: "Import Contract Commission Costs",
    description:
      "Import up to 500 commission or fulfillment rows; each row reports whether it capitalized or needs a contract link. Find contract and account ids with revenue and accounting reads.",
    permission: "contract_costs.manage",
    featureKey: "contractCosts",
    inputSchema: z.object({
      rows: z
        .array(
          z.object({
            repPartyId: UUID.optional(),
            customerPartyId: UUID.optional(),
            contractNumber: z
              .string()
              .max(60)
              .optional()
              .describe("Existing revenue contract number, if known."),
            costType: z.enum(["commission", "fulfilment"]).optional().describe("Cost category."),
            amount: exactMoneyText,
            currency: z
              .string()
              .regex(/^[A-Z]{3}$/)
              .describe("Uppercase ISO 4217 currency code."),
            date: DATE,
            method: z
              .enum(["straight_line", "pattern"])
              .optional()
              .describe("Amortization method."),
            originalExpenseAccountId: UUID,
            renewalCommission: exactMoneyText
              .nullable()
              .optional()
              .describe("Optional exact decimal renewal commission."),
            ref: z.string().max(200).optional().describe("Optional source reference."),
          }),
        )
        .min(1)
        .max(500)
        .describe("Commission or fulfillment cost rows to import."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const rows = [];
      for (const row of input.rows)
        rows.push({
          repPartyId: row.repPartyId,
          customerPartyId: row.customerPartyId,
          contractNumber: row.contractNumber,
          costType: row.costType,
          amountMinor: await parseCostAmountMinor(
            context.authz.user.orgId,
            row.amount,
            row.currency,
          ),
          currency: row.currency,
          date: row.date,
          method: row.method,
          originalExpenseAccountId: row.originalExpenseAccountId,
          renewalCommissionMinor: row.renewalCommission
            ? await parseCostAmountMinor(
                context.authz.user.orgId,
                row.renewalCommission,
                row.currency,
                { allowZero: true },
              )
            : undefined,
          ref: row.ref,
        });
      const result = await importCommissionCosts({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        rows,
      });
      return { ok: true, rows: result, href: "/revenue/contract-costs" };
    },
  }),
  mutationTool({
    name: "link_contract_cost_asset",
    title: "Link Contract Cost Asset",
    description:
      "Link an imported cost asset to its revenue contract so its amortization schedule can be derived. Find ids in the contract-cost workspace and revenue contract reads.",
    permission: "contract_costs.manage",
    featureKey: "contractCosts",
    inputSchema: z.object({
      assetId: UUID,
      revenueContractId: UUID,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const result = await linkContractCostAsset({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        assetId: input.assetId,
        revenueContractId: input.revenueContractId,
      });
      return { ok: true, ...result, href: "/revenue/contract-costs" };
    },
  }),
  mutationTool({
    name: "run_contract_cost_amortization",
    title: "Run Contract Cost Amortization",
    description:
      "Post due contract-cost amortization for an accounting period; closed periods and unlinked costs are reported by the engine. Find period ids in accounting-period reads.",
    permission: "contract_costs.manage",
    featureKey: "contractCosts",
    inputSchema: z.object({ periodId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    execute: async (context, input) => {
      const result = await runContractCostAmortization({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        periodId: input.periodId,
      });
      return { ok: true, ...result, href: "/revenue/contract-costs" };
    },
  }),
  mutationTool({
    name: "propose_revenue_contract_modification",
    title: "Propose Revenue Contract Modification",
    description:
      "Propose an effective-dated contract change with rights evidence, assessment, per-book FX rates and revised promises. Find the contract id and current obligations with get_revenue_contract.",
    permission: "ar.post",
    featureKey: "revenueRecognition",
    inputSchema: revenueModification.extend({
      contractId: UUID.describe("Revenue contract to modify."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { contractId, idempotencyKey: _key, ...modification } = input;
      assertSubsidiaryAccess(context, modification.subsidiaryId);
      const normalizedModification = {
        ...modification,
        bookRates: modification.bookRates.map((rate) => ({
          ...rate,
          fxRate: canonicalDecimal(rate.fxRate, 10)!,
        })),
        groups: modification.groups.map((group) => ({
          ...group,
          considerationChange: normalizeMoney(canonicalDecimal(group.considerationChange, 4)!),
          promises: group.promises.map((promise) => ({
            ...promise,
            standaloneSellingPrice: normalizeMoney(
              canonicalDecimal(promise.standaloneSellingPrice, 4)!,
            ),
            percentComplete: normalizeMoney(canonicalDecimal(promise.percentComplete, 4)!),
            events: promise.events?.map((event) => ({
              ...event,
              amount: normalizeMoney(canonicalDecimal(event.amount, 4)!),
            })),
          })),
        })),
      };
      const result = await proposeRevenueModification(
        context.authz.user.orgId,
        contractId,
        context.authz.user.id,
        normalizedModification,
      );
      return { ok: true, ...result, href: `/revenue?contract=${contractId}` };
    },
  }),
  mutationTool({
    name: "set_revenue_contract_pricing",
    title: "Set Revenue Contract Pricing",
    description:
      "Set fixed and variable consideration or a significant financing component on a revenue contract. Find its id with get_revenue_contract; the contract must be in a modifiable state.",
    permission: "ar.post",
    featureKey: "revenueRecognition",
    inputSchema: z.object({
      contractId: UUID,
      fixedConsideration: exactMoneyText.describe("Exact decimal fixed transaction price."),
      variable: pricingVariable,
      financing: z
        .object({
          annualRatePercent: z
            .string()
            .max(40)
            .regex(/^\d{1,3}(?:\.\d{1,4})?$/)
            .describe("Exact decimal annual interest rate percentage."),
          years: z.number().int().describe("Financing period in years."),
        })
        .strict()
        .nullable()
        .optional()
        .describe("Optional significant financing component."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const subsidiaryId = await getContractPricingSubsidiary(
        context.authz.user.orgId,
        input.contractId,
      );
      if (subsidiaryId === undefined)
        throw new ApplicationError("not_found", "revenue contract not found", 404);
      assertSubsidiaryAccess(context, subsidiaryId);
      const { contractId, idempotencyKey: _key, ...pricing } = input;
      const result = await setContractPricing(
        context.authz.user.orgId,
        contractId,
        pricing,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, ...result, href: `/revenue?contract=${contractId}` };
    },
  }),
  mutationTool({
    name: "control_revenue_recognition",
    title: "Control Revenue Recognition",
    description:
      "Place an obligation on hold, release a hold or record delivery evidence before recognition. Find obligation ids and current control revisions with get_revenue_contract.",
    permission: "ar.post",
    featureKey: "revenueRecognition",
    inputSchema: z.object({
      obligationId: UUID,
      action: z.enum(["hold", "release", "deliver"]).describe("Recognition control transition."),
      reason: z.string().trim().min(8).max(1000).describe("Audit reason for the control change."),
      expectedRevision: z
        .number()
        .int()
        .positive()
        .describe("Current control revision from get_revenue_contract."),
      effectiveOn: DATE.optional(),
      evidence: z
        .string()
        .trim()
        .min(8)
        .max(4000)
        .optional()
        .describe("Acceptance or fulfillment evidence required to mark delivery."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { obligationId, idempotencyKey: _key, ...body } = input;
      const result = await controlRecognition(
        context.authz.user.orgId,
        context.authz.user.id,
        obligationId,
        body,
      );
      return { ok: true, ...result, href: `/revenue?obligation=${obligationId}` };
    },
  }),
  mutationTool({
    name: "reconcile_legacy_revenue_obligation",
    title: "Reconcile Legacy Revenue Obligation",
    description:
      "Attest that a legacy obligation's existing schedule matches the policy in force when it was created, allowing governed schedule rebuilds. Find obligation ids with get_revenue_contract.",
    permission: "ar.post",
    featureKey: "revenueRecognition",
    inputSchema: z.object({
      obligationId: UUID,
      reason: z.string().trim().min(5).max(500).describe("Evidence-backed reconciliation reason."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await reconcileLegacyObligation({
        orgId: context.authz.user.orgId,
        obligationId: input.obligationId,
        actorId: context.authz.user.id,
        reason: input.reason,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
      });
      return {
        ok: true,
        obligationId: input.obligationId,
        status: "reconciled",
        href: `/revenue?obligation=${input.obligationId}`,
      };
    },
  }),
  readTool({
    name: "preview_revenue_recognition",
    title: "Preview Revenue Recognition",
    description:
      "Preview due schedule lines, balanced journal pairs, skips and the confirmation fingerprint before running recognition. Find obligation and contract ids with list_revenue_recognition_candidates.",
    permission: "ar.post",
    featureKey: "revenueRecognition",
    inputSchema: z.object({
      asOfDate: DATE.optional()
        .nullable()
        .describe("Recognition cutoff; defaults to the business date."),
      obligationId: UUID.optional().nullable(),
      contractId: UUID.optional().nullable(),
      bookId: UUID.optional().nullable(),
      periodId: UUID.optional().nullable(),
    }),
    execute: async (context, input) => {
      const outcome = await buildRevenueRecognitionPreview(
        context.authz.user.orgId,
        context.authz.allowedSubsidiaryIds,
        input,
      );
      if (!outcome.ok)
        throw new ApplicationError("invalid_input", outcome.error, 422, { field: outcome.field });
      return { ok: true, ...outcome.preview, href: "/revenue" };
    },
  }),
  mutationTool({
    name: "run_revenue_recognition",
    title: "Run Revenue Recognition",
    description:
      "Post due, unposted revenue recognition lines through the ledger engine. Preview first with preview_revenue_recognition; pass its fingerprint and scope to refuse stale confirmations.",
    permission: "ar.post",
    featureKey: "revenueRecognition",
    inputSchema: z.object({
      asOfDate: DATE.optional(),
      obligationId: UUID.optional(),
      contractId: UUID.optional(),
      bookId: UUID.optional(),
      periodId: UUID.optional(),
      fingerprint: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Fingerprint returned by preview_revenue_recognition."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const result = await executeRevenueRecognitionRun(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
        {
          asOfDate: input.asOfDate ?? (await businessToday(context.authz.user.orgId)),
          obligationId: input.obligationId,
          contractId: input.contractId,
          bookId: input.bookId,
          periodId: input.periodId,
          fingerprint: input.fingerprint,
        },
      );
      return { ok: true, ...result, href: "/revenue" };
    },
  }),
];
