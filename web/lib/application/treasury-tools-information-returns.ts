import "server-only";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  ensureFiling,
  FORM_TYPES,
  InformationReturnError,
  filingExceptionGuidance,
  finalizeFiling,
  markFilingFiled,
  recomputeFiling,
  stampRecipientCopiesPrinted,
  updateFilingRecipient,
  voidFiling,
  type FormType,
} from "@openbooks/engine/compliance/information-returns";
import { loadFilings, loadInformationReturnFilingScope } from "../compliance";
import { can } from "../authz";
import { assertSubsidiaryAccess, type ApplicationContext } from "./context";
import { ApplicationError, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  assertTreasuryGate,
  IDEMPOTENCY_KEY,
  runOutsideTenantTransaction,
  settleDomainRefusal,
  UUID,
} from "./treasury-tools-common";
import { z } from "zod";

const filingId = UUID.describe(
  "Information return filing UUID from list_information_return_filings.",
);
const recipientId = UUID.describe("Recipient UUID from the filing worksheet.");
const filingHref = (id: string) =>
  `/compliance/information-returns?filing=${encodeURIComponent(id)}`;

async function scopedFiling(context: ApplicationContext, id: string) {
  const scope = await loadInformationReturnFilingScope(context.authz.user.orgId, id);
  if (!scope) throw notFound("record");
  assertSubsidiaryAccess(context, scope.subsidiaryId);
  return scope;
}

async function readFiling(context: ApplicationContext, id: string) {
  const rows = await loadFilings(context.authz.user.orgId, context.authz.allowedSubsidiaryIds);
  const row = rows.find((filing) => filing.id === id);
  if (!row) throw notFound("record");
  return row;
}

function settleInformationReturn(error: unknown): never {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof InformationReturnError) {
    settleDomainRefusal({ message: error.message, status: error.status });
  }
  settleDomainRefusal(error);
}

async function listFilingResult(context: ApplicationContext, id: string) {
  const filing = await readFiling(context, id);
  return { ok: true, filing, status: filing.status, href: filingHref(id) };
}

const commonMutation = {
  readOnly: false,
  destructive: false,
  openWorld: false,
  assistantConfirmation: "always" as const,
  featureKey: "informationReturns",
};

export const TREASURY_INFORMATION_RETURN_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_information_return_filings",
    title: "List Information Return Filings",
    description:
      "Find information return filing IDs and their year, form, status, counts, and filed totals before preparing or filing a return. Requires compliance.read; the list respects your subsidiary access.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "informationReturns",
    visibleTo: (authz) => can(authz, "compliance.read"),
    execute: async (context) => {
      await assertTreasuryGate(context, "compliance.read", "informationReturns");
      return {
        filings: await loadFilings(context.authz.user.orgId, context.authz.allowedSubsidiaryIds),
        href: "/compliance/information-returns",
      };
    },
  }),
  definition({
    name: "prepare_information_return",
    title: "Prepare Information Return",
    description:
      "Open a draft information return for a completed tax year and installed form, or retrieve the existing filing for that year and entity. Use list_information_return_filings to find and verify filing IDs.",
    inputSchema: z.object({
      formType: z.enum(FORM_TYPES).describe("Installed form type, such as 1099-NEC or T4A."),
      taxYear: z
        .union([
          z.number().int(),
          z
            .string()
            .regex(/^\d{4}$/)
            .transform(Number),
        ])
        .pipe(z.number().int().min(1990).max(2200))
        .describe("Completed tax year as a four-digit year."),
      subsidiaryId: UUID.nullable()
        .optional()
        .describe("Optional active subsidiary UUID; omit for an organization-wide return."),
      threshold: z
        .string()
        .regex(/^\d+(?:\.\d{1,4})?$/)
        .optional()
        .describe("Optional exact filing threshold amount as a decimal string."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    ...commonMutation,
    visibleTo: (authz) => can(authz, "compliance.manage"),
    execute: async (context, input) => {
      await assertTreasuryGate(context, "compliance.manage", "informationReturns");
      const subsidiaryId = input.subsidiaryId ?? null;
      assertSubsidiaryAccess(context, subsidiaryId);
      try {
        const currentYear = Number((await businessToday(context.authz.user.orgId)).slice(0, 4));
        if (input.taxYear >= currentYear) {
          settleDomainRefusal({
            message: "only completed tax years can be filed — that tax year has not ended yet",
            status: 422,
          });
        }
        const result = await ensureFiling({
          orgId: context.authz.user.orgId,
          taxYear: input.taxYear,
          formType: input.formType as FormType,
          subsidiaryId,
          threshold: input.threshold,
          actorId: context.authz.user.id,
        });
        return {
          ok: true,
          id: result.id,
          filing: result,
          status: result.status,
          href: filingHref(result.id),
        };
      } catch (error) {
        settleInformationReturn(error);
      }
    },
  }),
  definition({
    name: "recompute_information_return",
    title: "Recompute Information Return",
    description:
      "Rebuild a draft or computed information return from the ledger while preserving recipient adjustments and exclusions. The filing must be in draft or computed status; use list_information_return_filings to find its ID.",
    inputSchema: z.object({ filingId, idempotencyKey: IDEMPOTENCY_KEY }),
    ...commonMutation,
    visibleTo: (authz) => can(authz, "compliance.manage"),
    execute: async (context, input) => {
      await assertTreasuryGate(context, "compliance.manage", "informationReturns");
      await scopedFiling(context, input.filingId);
      try {
        const result = await runOutsideTenantTransaction(context, () =>
          recomputeFiling({
            orgId: context.authz.user.orgId,
            filingId: input.filingId,
            actorId: context.authz.user.id,
          }),
        );
        return {
          ok: true,
          id: input.filingId,
          recipients: result.computation.recipients.length,
          tracedCash: result.computation.tracedCash,
          exceptions: result.computation.exceptions.map((exception) => ({
            ...exception,
            ...filingExceptionGuidance(exception),
          })),
          status: result.filing.status,
          href: filingHref(input.filingId),
        };
      } catch (error) {
        settleInformationReturn(error);
      }
    },
  }),
  definition({
    name: "finalize_information_return",
    title: "Finalize Information Return",
    description:
      "Freeze a computed information return after its source evidence, included recipients, and taxpayer IDs pass validation. Finalized returns are immutable; use list_information_return_filings to find its ID.",
    inputSchema: z.object({ filingId, idempotencyKey: IDEMPOTENCY_KEY }),
    ...commonMutation,
    visibleTo: (authz) => can(authz, "compliance.file"),
    execute: async (context, input) => {
      await assertTreasuryGate(context, "compliance.file", "informationReturns");
      await scopedFiling(context, input.filingId);
      try {
        await runOutsideTenantTransaction(context, () =>
          finalizeFiling({
            orgId: context.authz.user.orgId,
            filingId: input.filingId,
            actorId: context.authz.user.id,
          }),
        );
        return await listFilingResult(context, input.filingId);
      } catch (error) {
        settleInformationReturn(error);
      }
    },
  }),
  definition({
    name: "record_information_return_filing",
    title: "Record Information Return Filing",
    description:
      "Record a completed external filing for a finalized return, including the filing channel and optional confirmation reference. The return must already be finalized; use list_information_return_filings to find its ID.",
    inputSchema: z.object({
      filingId,
      channel: z
        .enum(["iris", "fire", "paper", "provider", "other"])
        .describe("Filing channel used."),
      reference: z
        .string()
        .trim()
        .max(200)
        .nullable()
        .optional()
        .describe("Optional confirmation reference."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    ...commonMutation,
    visibleTo: (authz) => can(authz, "compliance.file"),
    execute: async (context, input) => {
      await assertTreasuryGate(context, "compliance.file", "informationReturns");
      await scopedFiling(context, input.filingId);
      try {
        await runOutsideTenantTransaction(context, () =>
          markFilingFiled({
            orgId: context.authz.user.orgId,
            filingId: input.filingId,
            channel: input.channel,
            reference: input.reference,
            actorId: context.authz.user.id,
          }),
        );
        return await listFilingResult(context, input.filingId);
      } catch (error) {
        settleInformationReturn(error);
      }
    },
  }),
  definition({
    name: "void_information_return_filing",
    title: "Void Information Return Filing",
    description:
      "Void a draft, computed, or finalized information return with a reason; filed returns are permanent evidence and cannot be voided. Use list_information_return_filings to find its ID.",
    inputSchema: z.object({
      filingId,
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reason this unfiled return is being voided."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    ...commonMutation,
    destructive: true,
    visibleTo: (authz) => can(authz, "compliance.file"),
    execute: async (context, input) => {
      await assertTreasuryGate(context, "compliance.file", "informationReturns");
      await scopedFiling(context, input.filingId);
      try {
        await runOutsideTenantTransaction(context, () =>
          voidFiling({
            orgId: context.authz.user.orgId,
            filingId: input.filingId,
            actorId: context.authz.user.id,
            reason: input.reason,
          }),
        );
        return await listFilingResult(context, input.filingId);
      } catch (error) {
        settleInformationReturn(error);
      }
    },
  }),
  definition({
    name: "update_information_return_recipient",
    title: "Update Information Return Recipient",
    description:
      "Adjust box amounts or include or exclude a recipient on a draft or computed return; amount changes require a reason. The filing worksheet supplies both IDs and shows the editable state.",
    inputSchema: z
      .object({
        filingId,
        recipientId,
        adjustments: z
          .record(
            z.string().describe("Form box key from the filing worksheet."),
            z
              .string()
              .regex(/^-?\d+(?:\.\d{1,4})?$/)
              .describe("Exact adjustment amount as a decimal string."),
          )
          .optional()
          .describe("Replacement set of exact amounts keyed by valid form boxes."),
        adjustmentReason: z
          .string()
          .trim()
          .max(2000)
          .nullable()
          .optional()
          .describe("Required reason when setting nonzero adjustments."),
        status: z
          .enum(["included", "excluded"])
          .optional()
          .describe("Whether this recipient is included in the return."),
        exclusionReason: z
          .string()
          .trim()
          .max(2000)
          .nullable()
          .optional()
          .describe("Reason for excluding this recipient."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (input) =>
          input.status !== undefined ||
          input.adjustments !== undefined ||
          input.adjustmentReason !== undefined ||
          input.exclusionReason !== undefined,
        { message: "provide a status, adjustment, or reason to update the recipient" },
      ),
    ...commonMutation,
    visibleTo: (authz) => can(authz, "compliance.manage"),
    execute: async (context, input) => {
      await assertTreasuryGate(context, "compliance.manage", "informationReturns");
      await scopedFiling(context, input.filingId);
      try {
        await runOutsideTenantTransaction(context, () =>
          updateFilingRecipient({
            orgId: context.authz.user.orgId,
            filingId: input.filingId,
            recipientId: input.recipientId,
            actorId: context.authz.user.id,
            adjustments: input.adjustments,
            adjustmentReason: input.adjustmentReason,
            status: input.status,
            exclusionReason: input.exclusionReason,
          }),
        );
        return {
          ok: true,
          id: input.recipientId,
          status: input.status ?? "updated",
          href: filingHref(input.filingId),
        };
      } catch (error) {
        settleInformationReturn(error);
      }
    },
  }),
  definition({
    name: "mark_information_return_copies_furnished",
    title: "Mark Information Return Copies Furnished",
    description:
      "Record that recipient copies have been furnished for a finalized or filed return, for all included recipients or one selected recipient. Use the filing worksheet to find the filing and recipient IDs.",
    inputSchema: z.object({
      filingId,
      recipientId: recipientId
        .nullable()
        .optional()
        .describe("Optional recipient UUID; omit to mark all included recipients."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    ...commonMutation,
    visibleTo: (authz) => can(authz, "compliance.manage"),
    execute: async (context, input) => {
      await assertTreasuryGate(context, "compliance.manage", "informationReturns");
      await scopedFiling(context, input.filingId);
      try {
        const result = await runOutsideTenantTransaction(context, () =>
          stampRecipientCopiesPrinted({
            orgId: context.authz.user.orgId,
            filingId: input.filingId,
            recipientId: input.recipientId ?? null,
            actorId: context.authz.user.id,
          }),
        );
        const filing = await readFiling(context, input.filingId);
        return {
          ok: true,
          id: input.filingId,
          furnished: result,
          status: filing.status,
          href: filingHref(input.filingId),
        };
      } catch (error) {
        settleInformationReturn(error);
      }
    },
  }),
];
