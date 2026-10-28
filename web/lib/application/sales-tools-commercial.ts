import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { can } from "../authz";
import { db } from "@openbooks/engine/platform/db";
import { withScopeSnapshot } from "@openbooks/engine/organization/scope";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { RebateError } from "@openbooks/engine/revenue/rebates";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { applyDocumentPromotion, listActivePromotions } from "../promotions";
import { PromotionRefusal } from "@openbooks/engine/sales/promotions";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { listRecordDrawerHref } from "../cross-module-drawer-links";
import { listRebateRecords, readRebateRecord } from "../rebate-reads";
import {
  approveRebateAgreementBody,
  approveRebateClaimBody,
  attestRebateCostBody,
  cancelRebateClaimBody,
  generateRebateClaimBody,
  prepareRebateSettlementBody,
  reassessRebatesBody,
  reverseRebatePaymentBody,
  runRebateAction,
  settleRebateClaimBody,
} from "../rebate-actions";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a rebate, promotion, document, party, or account read.");
const KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const settleRebateClaimInputBody = settleRebateClaimBody.extend({
  fxRate: z.string().max(40).describe("Exact settlement FX rate as decimal text."),
});
const attestRebateCostInputBody = attestRebateCostBody.extend({
  costAmount: z.string().max(40).describe("Exact cost amount as decimal text."),
  resaleAmount: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .describe("Optional exact resale amount as decimal text."),
});
const visible = (permission: string) => (authz: Parameters<typeof can>[0]) =>
  can(authz, permission);

function assertVisibleDocument(
  context: Parameters<typeof assertApplicationPermission>[0],
  subsidiaryId: string | null,
  kind: string,
) {
  if (
    context.authz.allowedSubsidiaryIds !== null &&
    (subsidiaryId === null || !context.authz.allowedSubsidiaryIds.has(subsidiaryId))
  ) {
    throw notFound(kind);
  }
}

function documentHref(kind: string, id: string) {
  const known = new Set([
    "quote",
    "sales_order",
    "purchase_order",
    "vendor_bill",
    "customer_invoice",
    "cash_sale",
    "rma",
  ]);
  if (known.has(kind))
    return listRecordDrawerHref(
      kind as
        | "quote"
        | "sales_order"
        | "purchase_order"
        | "vendor_bill"
        | "customer_invoice"
        | "cash_sale"
        | "rma",
      id,
    );
  return `/records/${encodeURIComponent(kind)}?doc=${encodeURIComponent(id)}`;
}

function settleRebate(error: unknown): never {
  if (error instanceof z.ZodError) {
    throw invalidInput(error.issues.map((issue) => issue.message).join("; "));
  }
  if (error instanceof ScopeNotFoundError) throw notFound("rebate record");
  if (error instanceof RebateError) {
    if (error.status === 404) throw notFound(error.message);
    if (error.status === 409) throw conflict(error.message);
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403);
    throw invalidInput(error.message);
  }
  throw error;
}

function settlePromotion(error: unknown): never {
  if (error instanceof PromotionRefusal) {
    const details = { code: error.code, ...(error.remedy ? { remedy: error.remedy } : {}) };
    if (error.status === 404) throw notFound(error.message);
    if (error.status === 409) throw conflict(error.message, details);
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403, details);
    throw invalidInput(error.message, details);
  }
  throw error;
}

export const SALES_COMMERCIAL_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_rebate_agreements",
    title: "List Rebate Agreements",
    description:
      "List rebate agreements visible to the current customer or vendor permissions, with status and paging filters. Use an agreement id with get_rebate_agreement before approving or generating a claim.",
    inputSchema: z.object({
      side: z
        .enum(["customer", "vendor"])
        .optional()
        .describe("Limit results to customer or vendor agreements."),
      status: z
        .enum(["draft", "approved"])
        .optional()
        .describe("Limit results to draft or approved agreements."),
      limit: z.number().int().min(1).max(200).default(50).describe("Maximum agreements to return."),
      offset: z
        .number()
        .int()
        .min(0)
        .max(1_000_000)
        .default(0)
        .describe("Number of agreements to skip."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "rebateManagement",
    visibleTo: visible("documents.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.read");
      const result = await withScopeSnapshot(context.authz.user.orgId, () =>
        listRebateRecords(context.authz.user.orgId, context.authz, "agreements", input),
      );
      return { ok: true, ...result, href: "/rebates" };
    },
  }),
  definition({
    name: "list_rebate_claims",
    title: "List Rebate Claims",
    description:
      "List rebate claims visible to the current customer or vendor permissions, with status and paging filters. Use a claim id with get_rebate_claim before approving or settling it.",
    inputSchema: z.object({
      side: z
        .enum(["customer", "vendor"])
        .optional()
        .describe("Limit results to customer or vendor claims."),
      status: z
        .enum(["draft", "approved", "document_pending", "settled", "cancelled"])
        .optional()
        .describe("Limit results to one claim lifecycle status."),
      limit: z.number().int().min(1).max(200).default(50).describe("Maximum claims to return."),
      offset: z
        .number()
        .int()
        .min(0)
        .max(1_000_000)
        .default(0)
        .describe("Number of claims to skip."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "rebateManagement",
    visibleTo: visible("documents.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.read");
      const result = await withScopeSnapshot(context.authz.user.orgId, () =>
        listRebateRecords(context.authz.user.orgId, context.authz, "claims", input),
      );
      return { ok: true, ...result, href: "/rebates?view=claims" };
    },
  }),
  definition({
    name: "get_rebate_agreement",
    title: "Get Rebate Agreement",
    description:
      "Read one rebate agreement and its accrual context before approval or claim generation. Find agreement ids with list_rebate_agreements.",
    inputSchema: z.object({ agreementId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "rebateManagement",
    visibleTo: visible("documents.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.read");
      const record = await withScopeSnapshot(context.authz.user.orgId, () =>
        readRebateRecord(context.authz.user.orgId, context.authz, "agreements", input.agreementId),
      );
      if (!record) throw notFound("rebate agreement");
      return { ok: true, ...record, href: `/rebates?record=${input.agreementId}` };
    },
  }),
  definition({
    name: "get_rebate_claim",
    title: "Get Rebate Claim",
    description:
      "Read one rebate claim with its agreement and settlement status before approval, credit creation, payment, reversal, or cancellation. Find claim ids with list_rebate_claims.",
    inputSchema: z.object({ claimId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "rebateManagement",
    visibleTo: visible("documents.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.read");
      const record = await withScopeSnapshot(context.authz.user.orgId, () =>
        readRebateRecord(context.authz.user.orgId, context.authz, "claims", input.claimId),
      );
      if (!record) throw notFound("rebate claim");
      return { ok: true, ...record, href: `/rebates?view=claims&record=${input.claimId}` };
    },
  }),
  definition({
    name: "approve_rebate_agreement",
    title: "Approve Rebate Agreement",
    description:
      "Approve a draft rebate agreement after reviewing its effective terms and accounts. Find agreement ids in the Rebates agreements view or rebate setup records.",
    inputSchema: approveRebateAgreementBody.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "rebateManagement",
    visibleTo: visible("documents.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.read");
      try {
        const { idempotencyKey: _key, ...body } = input;
        const result = await runRebateAction(context.authz.user.orgId, context.authz.user.id, body);
        return { ok: true, ...result, href: `/rebates?record=${input.agreementId}` };
      } catch (error) {
        settleRebate(error);
      }
    },
  }),
  definition({
    name: "generate_rebate_claim",
    title: "Generate Rebate Claim",
    description:
      "Calculate a claim from accrued rebates for an approved agreement and customer or vendor through a cutoff date. Find agreement and party ids with list_rebate_agreements and get_rebate_agreement.",
    inputSchema: generateRebateClaimBody.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "rebateManagement",
    visibleTo: visible("documents.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.read");
      try {
        const { idempotencyKey: _key, ...body } = input;
        const result = await runRebateAction(context.authz.user.orgId, context.authz.user.id, body);
        return { ok: true, ...result, href: `/rebates?view=claims&record=${result.id}` };
      } catch (error) {
        settleRebate(error);
      }
    },
  }),
  definition({
    name: "approve_rebate_claim",
    title: "Approve Rebate Claim",
    description:
      "Approve a draft rebate claim after reviewing its accrual basis and amount. Find claim ids with list_rebate_claims and get_rebate_claim.",
    inputSchema: approveRebateClaimBody.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "rebateManagement",
    visibleTo: visible("documents.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.read");
      try {
        const { idempotencyKey: _key, ...body } = input;
        const result = await runRebateAction(context.authz.user.orgId, context.authz.user.id, body);
        return { ok: true, ...result, href: `/rebates?view=claims&record=${input.claimId}` };
      } catch (error) {
        settleRebate(error);
      }
    },
  }),
  definition({
    name: "cancel_rebate_claim",
    title: "Cancel Rebate Claim",
    description:
      "Cancel a draft or approved rebate claim that has no linked settlement, recording the reason. Find claim ids with list_rebate_claims and get_rebate_claim.",
    inputSchema: cancelRebateClaimBody.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "rebateManagement",
    visibleTo: visible("documents.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.read");
      try {
        const { idempotencyKey: _key, ...body } = input;
        const result = await runRebateAction(context.authz.user.orgId, context.authz.user.id, body);
        return { ok: true, ...result, href: `/rebates?view=claims&record=${input.claimId}` };
      } catch (error) {
        settleRebate(error);
      }
    },
  }),
  definition({
    name: "prepare_rebate_settlement",
    title: "Prepare Rebate Settlement",
    description:
      "Create the native customer credit or vendor credit for an approved rebate claim. Find the claim with list_rebate_claims and get_rebate_claim; review tax treatment before creating the settlement.",
    inputSchema: prepareRebateSettlementBody.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "rebateManagement",
    visibleTo: visible("documents.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.read");
      try {
        const { idempotencyKey: _key, ...body } = input;
        const result = await runRebateAction(context.authz.user.orgId, context.authz.user.id, body);
        return { ok: true, ...result, href: documentHref(result.kind, result.documentId) };
      } catch (error) {
        settleRebate(error);
      }
    },
  }),
  definition({
    name: "settle_rebate_claim_by_bank",
    title: "Settle Rebate Claim By Bank",
    description:
      "Pay or receive an approved outside-scope rebate claim through a legal-entity bank account. Find claim and bank-account ids in the Rebates claim detail and account reads.",
    inputSchema: settleRebateClaimInputBody.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "rebateManagement",
    visibleTo: visible("documents.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.read");
      try {
        const { idempotencyKey: _key, ...body } = input;
        const result = await runRebateAction(
          context.authz.user.orgId,
          context.authz.user.id,
          settleRebateClaimBody.parse(body),
        );
        return { ok: true, ...result, href: `/rebates?view=claims&record=${input.claimId}` };
      } catch (error) {
        settleRebate(error);
      }
    },
  }),
  definition({
    name: "reverse_rebate_payment",
    title: "Reverse Rebate Payment",
    description:
      "Reverse a posted outside-scope rebate bank settlement into an open claim and post the reversal to the selected accounting period. Find the claim with list_rebate_claims and get_rebate_claim.",
    inputSchema: reverseRebatePaymentBody.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "rebateManagement",
    visibleTo: visible("documents.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.read");
      try {
        const { idempotencyKey: _key, ...body } = input;
        const result = await runRebateAction(context.authz.user.orgId, context.authz.user.id, body);
        return { ok: true, ...result, href: `/rebates?view=claims&record=${input.claimId}` };
      } catch (error) {
        settleRebate(error);
      }
    },
  }),
  definition({
    name: "attest_rebate_cost",
    title: "Attest Rebate Cost",
    description:
      "Record supported cost evidence for a native document line before assessing a rebate. Find the source line with get_record and provide its currency and evidence.",
    inputSchema: attestRebateCostInputBody.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "rebateManagement",
    visibleTo: visible("documents.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.read");
      try {
        const source = (
          await db.execute<{ documentId: string; kind: string; subsidiaryId: string | null }>(
            sql`
          select d.id as "documentId", d.kind, d.subsidiary_id as "subsidiaryId"
            from document_lines l join documents d on d.org_id=l.org_id and d.id=l.document_id
           where l.org_id=${context.authz.user.orgId} and l.id=${input.documentLineId}
        `,
            "objects",
          )
        )[0];
        if (!source) throw notFound("document line");
        assertVisibleDocument(context, source.subsidiaryId, "document line");
        const { idempotencyKey: _key, ...body } = input;
        const result = await runRebateAction(
          context.authz.user.orgId,
          context.authz.user.id,
          attestRebateCostBody.parse(body),
        );
        return { ok: true, ...result, href: documentHref(source.kind, source.documentId) };
      } catch (error) {
        settleRebate(error);
      }
    },
  }),
  definition({
    name: "reassess_document_rebates",
    title: "Reassess Document Rebates",
    description:
      "Recalculate accruals for a posted sales or purchase document after agreement approval or cost evidence changes. Find the document id with get_record.",
    inputSchema: reassessRebatesBody.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "rebateManagement",
    visibleTo: visible("documents.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.read");
      try {
        const source = (
          await db.execute<{ kind: string; subsidiary_id: string | null }>(
            sql`
          select kind, subsidiary_id from documents where org_id=${context.authz.user.orgId} and id=${input.documentId}
        `,
            "objects",
          )
        )[0];
        if (!source) throw notFound("document");
        assertVisibleDocument(context, source.subsidiary_id, "document");
        const { idempotencyKey: _key, ...body } = input;
        const result = await runRebateAction(context.authz.user.orgId, context.authz.user.id, body);
        return { ok: true, ...result, href: documentHref(source.kind, input.documentId) };
      } catch (error) {
        settleRebate(error);
      }
    },
  }),
  definition({
    name: "list_active_promotions",
    title: "List Active Promotions",
    description:
      "List currently active promotion codes that can be applied to a sales document. Use the promotion setup records for draft and archived promotions.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "promotions",
    visibleTo: visible("ar.create"),
    execute: async (context) => {
      assertApplicationPermission(context, "ar.create");
      return {
        ok: true,
        promotions: await listActivePromotions(context.authz.user.orgId),
        href: "/admin/setup/promotions",
      };
    },
  }),
  definition({
    name: "apply_promotion_to_document",
    title: "Apply Promotion To Document",
    description:
      "Apply one active promotion to a draft quote or sales order. Find the document with get_record and use the promotion id or exact code from list_active_promotions.",
    inputSchema: z
      .object({
        documentId: UUID,
        code: z.string().max(64).optional().describe("Promotion code from list_active_promotions."),
        promotionId: UUID.optional().describe("Promotion UUID from list_active_promotions."),
        idempotencyKey: KEY,
      })
      .refine((input) => Boolean(input.code || input.promotionId), {
        message: "Provide a promotion code or id.",
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "promotions",
    visibleTo: visible("ar.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ar.create");
      const doc = (
        await db.execute<{ kind: string; subsidiary_id: string | null }>(
          sql`
        select kind, subsidiary_id from documents where org_id=${context.authz.user.orgId} and id=${input.documentId}
      `,
          "objects",
        )
      )[0];
      if (!doc) throw notFound("document");
      assertVisibleDocument(context, doc.subsidiary_id, "document");
      try {
        const result = await applyDocumentPromotion({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          documentId: input.documentId,
          code: input.code,
          promotionId: input.promotionId,
          channelId: null,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, href: documentHref(doc.kind, input.documentId) };
      } catch (error) {
        settlePromotion(error);
      }
    },
  }),
];
