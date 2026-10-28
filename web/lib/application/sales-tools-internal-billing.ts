import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  listInternalBillingRules,
  loadInternalBilling,
  postInternalBilling,
  saveInternalBillingDraft,
  voidInternalBilling,
  InternalBillingError,
} from "@openbooks/engine/internal-billing";
import { internalBillingBody } from "../../app/api/internal-billing/_schema";
import { assertApplicationPermission } from "./context";
import { conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from the internal billing or account read.");
const KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
const visible = (permission: string) => (authz: Parameters<typeof can>[0]) =>
  can(authz, permission);

function settleInternalBilling(error: unknown): never {
  if (error instanceof InternalBillingError) {
    if (error.status === 404) throw notFound(error.message);
    if (error.status === 409) throw conflict(error.message);
    throw invalidInput(error.message);
  }
  throw error;
}

export const SALES_INTERNAL_BILLING_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_internal_billing",
    title: "Get Internal Billing Document",
    description:
      "Read one internal billing document and its revision before posting, editing, or voiding it. Use the returned id and revision for the next action.",
    inputSchema: z.object({ id: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "internalBilling",
    visibleTo: visible("gl.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "gl.read");
      try {
        const detail = await loadInternalBilling(
          context.authz.user.orgId,
          input.id,
          context.authz.allowedSubsidiaryIds,
        );
        if (!detail) throw notFound("internal billing document");
        return { ok: true, ...detail, href: `/internal-billing?doc=${input.id}` };
      } catch (error) {
        settleInternalBilling(error);
      }
    },
  }),
  definition({
    name: "list_internal_billing_rules",
    title: "List Internal Billing Rules",
    description:
      "List effective-dated internal billing rules before creating a document or adding a rule version. The rule code selects the treatment for a document date.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "internalBilling",
    visibleTo: visible("gl.read"),
    execute: async (context) => {
      assertApplicationPermission(context, "gl.read");
      try {
        return {
          ok: true,
          rules: await listInternalBillingRules(context.authz.user.orgId),
          href: "/internal-billing",
        };
      } catch (error) {
        settleInternalBilling(error);
      }
    },
  }),
  definition({
    name: "create_internal_billing_draft",
    title: "Create Internal Billing Draft",
    description:
      "Create an internal billing draft using the rule version in effect on its document date. Read internal billing rules and account records first; the result contains the draft id and revision.",
    inputSchema: internalBillingBody.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "internalBilling",
    visibleTo: visible("gl.post"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "gl.post");
      try {
        const { idempotencyKey: _key, ...body } = input;
        const saved = await saveInternalBillingDraft({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          input: body,
        });
        return { ok: true, ...saved, href: `/internal-billing?doc=${saved.id}` };
      } catch (error) {
        settleInternalBilling(error);
      }
    },
  }),
  definition({
    name: "update_internal_billing_draft",
    title: "Update Internal Billing Draft",
    description:
      "Replace the header and lines of an internal billing draft using its latest revision. Read the draft with get_internal_billing and pass the current revision to prevent overwriting a concurrent edit.",
    inputSchema: internalBillingBody.extend({
      id: UUID,
      expectedRevision: z
        .string()
        .nullable()
        .optional()
        .describe("Current revision returned by get_internal_billing."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "internalBilling",
    visibleTo: visible("gl.post"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "gl.post");
      try {
        const { id, expectedRevision, idempotencyKey: _key, ...body } = input;
        const saved = await saveInternalBillingDraft({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          id,
          input: body,
          expectedRevision: expectedRevision ?? null,
        });
        return { ok: true, ...saved, href: `/internal-billing?doc=${id}` };
      } catch (error) {
        settleInternalBilling(error);
      }
    },
  }),
  definition({
    name: "post_internal_billing",
    title: "Post Internal Billing",
    description:
      "Submit an internal billing draft for approval or post it when no approval is required. Read the document first; the result reports whether approval is pending or the journal was posted.",
    inputSchema: z.object({ id: UUID, idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "internalBilling",
    visibleTo: visible("gl.post"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "gl.post");
      try {
        const outcome = await postInternalBilling({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          id: input.id,
        });
        return { ok: true, ...outcome, href: `/internal-billing?doc=${input.id}` };
      } catch (error) {
        settleInternalBilling(error);
      }
    },
  }),
  definition({
    name: "void_internal_billing",
    title: "Void Internal Billing",
    description:
      "Void an internal billing document through its governed reversal and approval flow. Read the current document revision first and provide a reason; posted history is reversed, not deleted.",
    inputSchema: z.object({
      id: UUID,
      reason: z.string().min(1).max(1000).describe("Business reason for the void."),
      reversalDate: DATE.nullable()
        .optional()
        .describe("Date of the reversal journal, or null for the business date."),
      expectedRevision: z
        .string()
        .nullable()
        .optional()
        .describe("Current revision returned by get_internal_billing."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "internalBilling",
    visibleTo: visible("gl.post"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "gl.post");
      try {
        const result = await voidInternalBilling({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          id: input.id,
          reason: input.reason,
          reversalDate: input.reversalDate,
          expectedRevision: input.expectedRevision,
        });
        return { ok: true, ...result, href: `/internal-billing?doc=${input.id}` };
      } catch (error) {
        settleInternalBilling(error);
      }
    },
  }),
];
