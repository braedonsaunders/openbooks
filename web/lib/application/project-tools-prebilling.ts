import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { isDocumentRevisionToken } from "@openbooks/engine/records/revision";
import { can, type Authz } from "../authz";
import {
  convertPrebill,
  createPrebill,
  deliverPrebillInvoice,
  holdPrebillLine,
  loadPrebill,
  PreBillingError,
  releasePrebillHold,
  runBillRun,
  sendPrebillToCustomer,
  transitionPrebill,
  updatePrebillLine,
} from "../pre-billing";
import { isFeatureEnabled } from "../features";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from list_prebills, get_prebill, or the related project read.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const canManage = (authz: Authz) => can(authz, "projects.manage");

async function requirePrebilling(context: ApplicationContext): Promise<void> {
  const orgId = context.authz.user.orgId;
  if (
    !(await isFeatureEnabled(orgId, "projects")) ||
    !(await isFeatureEnabled(orgId, "preBilling"))
  ) {
    throw notFound("pre-billing");
  }
}

function settlePrebill(error: unknown): never {
  if (error instanceof PreBillingError) {
    if (error.status === 404) throw new ApplicationError("not_found", error.message, 404);
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403);
    if (error.status === 409) throw conflict(error.message);
    throw invalidInput(error.message);
  }
  throw error;
}

async function readPrebill(context: ApplicationContext, id: string) {
  const prebill = await loadPrebill(
    context.authz.user.orgId,
    id,
    context.authz.allowedSubsidiaryIds,
  );
  if (!prebill) throw notFound("prebill");
  return prebill;
}

export const PROJECT_PREBILLING_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "create_prebill",
    title: "Create Pre-Billing Worksheet",
    description:
      "Snapshot eligible unbilled project work into a draft pre-billing worksheet for an explicit period. Find the project with list_records and verify the worksheet with get_prebill.",
    inputSchema: z.object({
      projectId: UUID,
      periodStart: DATE.nullable()
        .optional()
        .describe("Optional first day of the billed work period."),
      periodEnd: DATE,
      notes: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Optional note saved on the worksheet."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "preBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requirePrebilling(context);
      try {
        const created = await createPrebill(
          context.authz.user.orgId,
          context.authz.user.id,
          {
            projectId: input.projectId,
            periodStart: input.periodStart ?? null,
            periodEnd: input.periodEnd,
            notes: input.notes ?? null,
          },
          context.authz.allowedSubsidiaryIds,
        );
        const prebill = await readPrebill(context, created.id);
        return { ok: true, prebill, href: `/pre-billing/${created.id}` };
      } catch (error) {
        settlePrebill(error);
      }
    },
  }),
  definition({
    name: "run_prebilling",
    title: "Run Project Pre-Billing",
    description:
      "Prepare one draft worksheet for each selected project with eligible unbilled work through the cutoff, or run across all visible projects. Read each created worksheet with get_prebill.",
    inputSchema: z.object({
      periodStart: DATE.nullable()
        .optional()
        .describe("Optional first day of the billed work period."),
      periodEnd: DATE,
      projectIds: z
        .array(UUID)
        .max(1000)
        .nullable()
        .optional()
        .describe(
          "Projects to include; omit to select every eligible project in the caller's subsidiary scope.",
        ),
      notes: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Optional note copied to each worksheet."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "preBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requirePrebilling(context);
      try {
        const result = await runBillRun(
          context.authz.user.orgId,
          context.authz.user.id,
          {
            periodStart: input.periodStart ?? null,
            periodEnd: input.periodEnd,
            projectIds: input.projectIds ?? null,
            notes: input.notes ?? null,
          },
          context.authz.allowedSubsidiaryIds,
        );
        return {
          ok: true,
          ...result,
          href: result.created[0] ? `/pre-billing/${result.created[0].id}` : "/pre-billing",
        };
      } catch (error) {
        settlePrebill(error);
      }
    },
  }),
  definition({
    name: "update_prebill_line",
    title: "Update Pre-Billing Line",
    description:
      "Adjust a draft worksheet line using its current revision from get_prebill. A write-up or write-down requires a reason and supporting evidence.",
    inputSchema: z.object({
      prebillId: UUID,
      lineId: UUID,
      proposedBillAmount: z
        .string()
        .max(40)
        .describe("Exact decimal amount to bill; never send a JSON number."),
      expectedUpdatedAt: z
        .string()
        .min(1)
        .max(200)
        .describe("The exact line revision returned by get_prebill."),
      adjustmentReason: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Reason for a changed billing amount."),
      adjustmentEvidence: z
        .array(z.string().max(2000))
        .max(100)
        .optional()
        .describe("Evidence references supporting a changed billing amount."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "preBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requirePrebilling(context);
      if (!isDocumentRevisionToken(input.expectedUpdatedAt)) {
        throw new ApplicationError(
          "conflict",
          "A current line revision is required; reload the worksheet and try again",
          409,
        );
      }
      try {
        await updatePrebillLine(
          context.authz.user.orgId,
          context.authz.user.id,
          input.prebillId,
          input.lineId,
          {
            proposedBillAmount: input.proposedBillAmount,
            adjustmentReason: input.adjustmentReason ?? null,
            adjustmentEvidence: input.adjustmentEvidence ?? [],
          },
          context.authz.allowedSubsidiaryIds,
          { expectedRevision: input.expectedUpdatedAt },
        );
        const prebill = await readPrebill(context, input.prebillId);
        return { ok: true, prebill, lineId: input.lineId, href: `/pre-billing/${input.prebillId}` };
      } catch (error) {
        settlePrebill(error);
      }
    },
  }),
  definition({
    name: "hold_prebill_line",
    title: "Hold Pre-Billing Line",
    description:
      "Place an eligible source line on hold in a draft worksheet with a reason and optional evidence. Find the line with get_prebill and verify the saved hold there.",
    inputSchema: z.object({
      prebillId: UUID,
      lineId: UUID,
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Why this source line must be held from billing."),
      evidence: z
        .array(z.string().max(2000))
        .max(100)
        .optional()
        .describe("Optional evidence references for the hold."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "preBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requirePrebilling(context);
      try {
        const hold = await holdPrebillLine(
          context.authz.user.orgId,
          context.authz.user.id,
          input.prebillId,
          input.lineId,
          input.reason,
          input.evidence ?? [],
          context.authz.allowedSubsidiaryIds,
        );
        const prebill = await readPrebill(context, input.prebillId);
        return { ok: true, hold, prebill, href: `/pre-billing/${input.prebillId}` };
      } catch (error) {
        settlePrebill(error);
      }
    },
  }),
  definition({
    name: "release_prebill_hold",
    title: "Release Pre-Billing Hold",
    description:
      "Release an active source hold with an audit reason so eligible draft worksheets can bill the source again. Find hold ids from the pre-billing workspace or get_prebill.",
    inputSchema: z.object({
      holdId: UUID,
      reason: z.string().trim().min(1).max(2000).describe("Reason for releasing the hold."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "preBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requirePrebilling(context);
      try {
        const result = await releasePrebillHold(
          context.authz.user.orgId,
          context.authz.user.id,
          input.holdId,
          input.reason,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, ...result, href: "/pre-billing" };
      } catch (error) {
        settlePrebill(error);
      }
    },
  }),
  definition({
    name: "submit_prebill",
    title: "Submit Pre-Billing Worksheet",
    description:
      "Submit a draft worksheet after its line, evidence, and contract-cap checks pass; configured native Flow approval may leave it pending. Find it with list_prebills and verify with get_prebill.",
    inputSchema: z.object({ prebillId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "preBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requirePrebilling(context);
      try {
        const result = await transitionPrebill(
          context.authz.user.orgId,
          context.authz.user.id,
          input.prebillId,
          "submit",
          undefined,
          context.authz.allowedSubsidiaryIds,
        );
        const prebill = await readPrebill(context, input.prebillId);
        return { ok: true, ...result, prebill, href: `/pre-billing/${input.prebillId}` };
      } catch (error) {
        settlePrebill(error);
      }
    },
  }),
  definition({
    name: "reopen_prebill",
    title: "Reopen Pre-Billing Worksheet",
    description:
      "Return an approved or customer-review worksheet to draft with a recorded reason, clearing its prior approval or customer decision. Find it with list_prebills and verify with get_prebill.",
    inputSchema: z.object({
      prebillId: UUID,
      reason: z.string().trim().min(1).max(2000).describe("Reason for reopening the worksheet."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "preBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requirePrebilling(context);
      try {
        const result = await transitionPrebill(
          context.authz.user.orgId,
          context.authz.user.id,
          input.prebillId,
          "reopen",
          input.reason,
          context.authz.allowedSubsidiaryIds,
        );
        const prebill = await readPrebill(context, input.prebillId);
        return { ok: true, ...result, prebill, href: `/pre-billing/${input.prebillId}` };
      } catch (error) {
        settlePrebill(error);
      }
    },
  }),
  definition({
    name: "void_prebill",
    title: "Void Pre-Billing Worksheet",
    description:
      "Void an unconverted worksheet with an audit reason, releasing its source reservation. Find it with list_prebills and verify with get_prebill.",
    inputSchema: z.object({
      prebillId: UUID,
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reason recorded for voiding the worksheet."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "preBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requirePrebilling(context);
      try {
        const result = await transitionPrebill(
          context.authz.user.orgId,
          context.authz.user.id,
          input.prebillId,
          "void",
          input.reason,
          context.authz.allowedSubsidiaryIds,
        );
        const prebill = await readPrebill(context, input.prebillId);
        return { ok: true, ...result, prebill, href: `/pre-billing/${input.prebillId}` };
      } catch (error) {
        settlePrebill(error);
      }
    },
  }),
  definition({
    name: "send_prebill_to_customer",
    title: "Send Pre-Bill for Customer Review",
    description:
      "Send an approved worksheet to its customer for portal review before invoice conversion. Find the approved worksheet with list_prebills and verify its review state with get_prebill.",
    inputSchema: z.object({
      prebillId: UUID,
      to: z
        .string()
        .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
        .max(320)
        .nullable()
        .optional()
        .describe(
          "Optional customer recipient email; otherwise use the customer's configured contact.",
        ),
      message: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Optional message to the customer."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "preBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requirePrebilling(context);
      try {
        const result = await sendPrebillToCustomer(
          context.authz.user.orgId,
          context.authz.user.id,
          input.prebillId,
          { to: input.to ?? null, message: input.message ?? null },
          context.authz.allowedSubsidiaryIds,
        );
        const prebill = await readPrebill(context, input.prebillId);
        return { ok: true, ...result, prebill, href: `/pre-billing/${input.prebillId}` };
      } catch (error) {
        settlePrebill(error);
      }
    },
  }),
  definition({
    name: "convert_prebill_to_invoice",
    title: "Convert Pre-Bill to Invoice",
    description:
      "Convert an approved worksheet with no unresolved customer review into a draft customer invoice, atomically reserving the source lines. Find the worksheet with get_prebill and verify the invoice with get_record.",
    inputSchema: z.object({ prebillId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ar.create"),
    featureKey: "preBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "ar.create");
      await requirePrebilling(context);
      try {
        const converted = await convertPrebill(
          context.authz.user.orgId,
          context.authz.user.id,
          input.prebillId,
          context.authz.allowedSubsidiaryIds,
        );
        return {
          ok: true,
          invoiceId: converted.id,
          documentNumber: converted.documentNumber,
          status: "draft",
          href: `/invoices/${converted.id}`,
        };
      } catch (error) {
        settlePrebill(error);
      }
    },
  }),
  definition({
    name: "deliver_prebill_invoice",
    title: "Deliver Pre-Bill Invoice",
    description:
      "Email the posted invoice created from a worksheet, including required billing backup. Find the converted worksheet with get_prebill; the invoice must already be posted.",
    inputSchema: z.object({
      prebillId: UUID,
      to: z
        .string()
        .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
        .max(320)
        .nullable()
        .optional()
        .describe("Optional invoice recipient email."),
      message: z.string().max(2000).nullable().optional().describe("Optional email message."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ar.create"),
    featureKey: "preBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "ar.create");
      await requirePrebilling(context);
      try {
        const result = await deliverPrebillInvoice(
          context.authz.user.orgId,
          context.authz.user.id,
          input.prebillId,
          { to: input.to ?? null, message: input.message ?? null },
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, ...result, href: `/pre-billing/${input.prebillId}` };
      } catch (error) {
        settlePrebill(error);
      }
    },
  }),
];
