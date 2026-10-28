import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import { withScopeSnapshot } from "@openbooks/engine/organization/scope";
import { readSubcontractDetail } from "@openbooks/engine/projects/subcontracts-read";
import { isFeatureEnabled } from "../features";
import { can, type Authz } from "../authz";
import { dispatchSubcontractAction } from "@/app/api/subcontracts/route";
import { assertApplicationPermission } from "./context";
import { ApplicationError, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from the subcontract or linked project read.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
const MONEY = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,4})?$/)
  .describe("Exact decimal amount as a string; never use a JSON number.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const REVISION = z
  .string()
  .min(1)
  .max(100)
  .describe("Exact updatedAt revision token copied from the subcontract read.");

type CommandSchema = z.ZodObject;

async function subcontractHrefId(
  orgId: string,
  authz: Authz,
  action: string,
  input: Record<string, unknown>,
  response: Record<string, unknown>,
): Promise<NonNullable<Awaited<ReturnType<typeof readSubcontractDetail>>>> {
  const candidate =
    (typeof response.id === "string" ? response.id : undefined) ??
    (typeof input.subcontractId === "string" ? input.subcontractId : undefined) ??
    (typeof input.payApplicationId === "string" ? input.payApplicationId : undefined) ??
    (typeof input.id === "string" ? input.id : undefined);
  if (!candidate) throw new Error(`The ${action} action did not identify its subcontract.`);
  const parent = await db.execute<{ id: string }>(
    sql`
      select id from subcontracts where org_id = ${orgId} and id = ${candidate}
      union all
      select subcontract_id as id from subcontract_sov_lines where org_id = ${orgId} and id = ${candidate}
      union all
      select subcontract_id as id from subcontract_change_orders where org_id = ${orgId} and id = ${candidate}
      union all
      select subcontract_id as id from vendor_pay_applications where org_id = ${orgId} and id = ${candidate}
      union all
      select subcontract_id as id from subcontract_payment_controls where org_id = ${orgId} and id = ${candidate}
      limit 1
    `,
    "objects",
  );
  const id = parent[0]?.id;
  if (!id) throw notFound("subcontract");
  const detail = await withScopeSnapshot(orgId, () =>
    readSubcontractDetail(db, { orgId, id, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }),
  );
  if (!detail) throw notFound("subcontract");
  return detail;
}

function makeSubcontractCommand(args: {
  name: string;
  title: string;
  description: string;
  permission: "ap.create" | "ap.post" | "ap.pay";
  action: string;
  schema: CommandSchema;
  destructive?: boolean;
}): ApplicationToolDefinition {
  const inputSchema = args.schema.extend({ idempotencyKey: IDEMPOTENCY_KEY });
  return definition({
    name: args.name,
    title: args.title,
    description: args.description,
    inputSchema,
    readOnly: false,
    destructive: args.destructive === true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, args.permission),
    featureKey: "subcontracts",
    execute: async (context, input) => {
      assertApplicationPermission(context, args.permission);
      const orgId = context.authz.user.orgId;
      if (!(await isFeatureEnabled(orgId, "subcontracts"))) throw notFound("subcontract");
      const { idempotencyKey: _key, ...fields } = input as Record<string, unknown>;
      const response = await dispatchSubcontractAction(
        { action: args.action, ...fields } as never,
        context.authz,
      );
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        const status = response.status;
        const code =
          status === 404
            ? "not_found"
            : status === 403
              ? "forbidden"
              : status === 409
                ? "conflict"
                : status >= 500
                  ? "internal_error"
                  : "invalid_input";
        const message =
          typeof payload.error === "string" ? payload.error : `${args.title} was refused`;
        throw new ApplicationError(code, message, status, payload);
      }
      const detail = await subcontractHrefId(orgId, context.authz, args.action, fields, payload);
      const subcontractId = String(detail.subcontract.id);
      const status = String(detail.subcontract.status);
      return {
        ok: true,
        ...payload,
        subcontract: detail,
        status,
        href: `/subcontracts?id=${subcontractId}`,
      };
    },
  });
}

export const PURCHASING_SUBCONTRACT_TOOLS: ApplicationToolDefinition[] = [
  makeSubcontractCommand({
    name: "create_subcontract",
    title: "Create Subcontract",
    permission: "ap.create",
    action: "createSubcontract",
    description:
      "Create a draft subcontract commitment for a project and vendor. Project, vendor, and optional purchase-order ids come from the project, party, and purchase-order reads.",
    schema: z.object({
      projectId: UUID.describe("Project receiving the commitment."),
      vendorId: UUID.describe("Subcontractor party."),
      number: z.string().trim().min(1).max(120).describe("Unique subcontract number."),
      title: z.string().trim().min(1).max(300).describe("Subcontract title."),
      description: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Optional work description."),
      currency: z
        .string()
        .length(3)
        .optional()
        .describe("Optional ISO currency; requires multi-currency to be enabled."),
      originalCommitment: MONEY.describe("Original committed amount."),
      defaultRetainagePercent: MONEY.nullable()
        .optional()
        .describe("Optional default retainage percentage."),
      purchaseOrderId: UUID.nullable().optional().describe("Optional related purchase-order id."),
      startsOn: DATE.nullable().optional().describe("Optional contract start date."),
      endsOn: DATE.nullable().optional().describe("Optional contract end date."),
    }),
  }),
  makeSubcontractCommand({
    name: "update_subcontract",
    title: "Update Subcontract",
    permission: "ap.create",
    action: "updateSubcontract",
    description:
      "Edit a draft subcontract before submitting it for approval. Find the subcontract and current updatedAt token with search_subcontracts or get_subcontract.",
    schema: z.object({
      id: UUID.describe("Draft subcontract id."),
      title: z.string().trim().min(1).max(300).describe("Updated subcontract title."),
      description: z.string().max(2000).nullable().optional().describe("Updated work description."),
      originalCommitment: MONEY.describe("Updated original commitment amount."),
      defaultRetainagePercent: MONEY.describe("Updated default retainage percentage."),
      startsOn: DATE.nullable().optional().describe("Optional contract start date."),
      endsOn: DATE.nullable().optional().describe("Optional contract end date."),
      expectedUpdatedAt: REVISION,
    }),
  }),
  makeSubcontractCommand({
    name: "add_subcontract_sov_line",
    title: "Add Subcontract Schedule Line",
    permission: "ap.create",
    action: "addSovLine",
    description:
      "Add a schedule of values line to a draft subcontract. Find the parent subcontract id with get_subcontract.",
    schema: z.object({
      subcontractId: UUID.describe("Parent subcontract id."),
      itemNo: z.string().max(40).nullable().optional().describe("Optional schedule item number."),
      description: z.string().trim().min(1).max(2000).describe("Work or cost description."),
      scheduledValue: MONEY.describe("Exact scheduled value."),
      retainagePercent: MONEY.nullable().optional().describe("Optional line retainage percentage."),
      expenseAccountId: UUID.nullable().optional().describe("Optional expense account id."),
      sortOrder: z.number().int().optional().describe("Optional display order."),
    }),
  }),
  makeSubcontractCommand({
    name: "remove_subcontract_sov_line",
    title: "Remove Subcontract Schedule Line",
    permission: "ap.create",
    action: "removeSovLine",
    destructive: true,
    description:
      "Remove an unused schedule of values line from a draft subcontract. Find line ids with get_subcontract.",
    schema: z.object({ id: UUID.describe("Schedule of values line id.") }),
  }),
  makeSubcontractCommand({
    name: "submit_subcontract",
    title: "Submit Subcontract",
    permission: "ap.create",
    action: "submitSubcontract",
    description:
      "Submit a complete draft subcontract into its configured approval flow. Find its id with search_subcontracts or get_subcontract.",
    schema: z.object({ id: UUID.describe("Draft subcontract id.") }),
  }),
  makeSubcontractCommand({
    name: "approve_subcontract",
    title: "Approve Subcontract",
    permission: "ap.create",
    action: "approveSubcontract",
    description:
      "Approve a pending subcontract when the caller is authorized by the native approval policy. Find its id and approval state with search_subcontracts or get_subcontract.",
    schema: z.object({ id: UUID.describe("Pending subcontract id.") }),
  }),
  makeSubcontractCommand({
    name: "transition_subcontract",
    title: "Transition Subcontract",
    permission: "ap.create",
    action: "transitionSubcontract",
    destructive: true,
    description:
      "Mark an active subcontract substantially complete, close it, or void it when its lifecycle permits. Find its id and current status with get_subcontract.",
    schema: z.object({
      id: UUID.describe("Subcontract id."),
      transition: z
        .enum(["substantially_complete", "close", "void"])
        .describe("Allowed native subcontract lifecycle transition."),
    }),
  }),
  makeSubcontractCommand({
    name: "add_subcontract_change_order",
    title: "Add Subcontract Change Order",
    permission: "ap.create",
    action: "addChangeOrder",
    description:
      "Add a draft change order to an active subcontract commitment. Find the parent and any schedule line ids with get_subcontract.",
    schema: z.object({
      subcontractId: UUID.describe("Parent subcontract id."),
      number: z.string().trim().min(1).max(120).describe("Unique change-order number."),
      description: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Optional change-order description."),
      amount: MONEY.describe("Exact change-order amount."),
      targetSovLineId: UUID.nullable()
        .optional()
        .describe("Optional schedule line receiving the change."),
    }),
  }),
  makeSubcontractCommand({
    name: "approve_subcontract_change_order",
    title: "Approve Subcontract Change Order",
    permission: "ap.create",
    action: "approveChangeOrder",
    description:
      "Approve a pending subcontract change order on its effective approval date. Find change-order ids and status with get_subcontract.",
    schema: z.object({
      id: UUID.describe("Pending change-order id."),
      approvedOn: DATE.describe("Approval effective date."),
    }),
  }),
  makeSubcontractCommand({
    name: "void_subcontract_change_order",
    title: "Void Subcontract Change Order",
    permission: "ap.create",
    action: "voidChangeOrder",
    destructive: true,
    description:
      "Void a draft or otherwise voidable subcontract change order. Find its id and status with get_subcontract.",
    schema: z.object({ id: UUID.describe("Change-order id.") }),
  }),
  makeSubcontractCommand({
    name: "create_subcontract_pay_application",
    title: "Create Subcontract Pay Application",
    permission: "ap.create",
    action: "createPayApplication",
    description:
      "Create a draft vendor pay application for a subcontract billing period. Find the parent subcontract id with get_subcontract.",
    schema: z.object({
      subcontractId: UUID.describe("Parent subcontract id."),
      periodEnd: DATE.describe("Billing period end date."),
      vendorInvoiceNumber: z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe("Optional vendor invoice reference."),
    }),
  }),
  makeSubcontractCommand({
    name: "update_subcontract_pay_application",
    title: "Update Subcontract Pay Application",
    permission: "ap.create",
    action: "updatePayApplication",
    description:
      "Edit work completed and stored materials on a draft pay application using its current integer revision. Find application ids, line ids, and revision with get_subcontract.",
    schema: z.object({
      payApplicationId: UUID.describe("Draft pay-application id."),
      expectedRevision: z
        .number()
        .int()
        .positive()
        .describe("Positive application revision copied from the read."),
      lines: z
        .array(
          z.object({
            sovLineId: UUID.describe("Schedule line id from the subcontract detail."),
            workCompletedThisPeriod: MONEY.optional().describe(
              "Exact amount of work completed this period; omitted means zero.",
            ),
            materialsStoredCurrent: MONEY.optional().describe(
              "Exact amount of new materials stored; omitted means zero.",
            ),
          }),
        )
        .max(500)
        .describe("Current pay-application line values."),
    }),
  }),
  makeSubcontractCommand({
    name: "submit_subcontract_pay_application",
    title: "Submit Subcontract Pay Application",
    permission: "ap.create",
    action: "submitPayApplication",
    description:
      "Submit a complete draft pay application into its approval flow. Find its id and status with get_subcontract.",
    schema: z.object({ id: UUID.describe("Draft pay-application id.") }),
  }),
  makeSubcontractCommand({
    name: "approve_subcontract_pay_application",
    title: "Approve Subcontract Pay Application",
    permission: "ap.create",
    action: "approvePayApplication",
    description:
      "Approve a pending subcontract pay application when authorized by its native policy. Find its id and status with get_subcontract.",
    schema: z.object({ id: UUID.describe("Pending pay-application id.") }),
  }),
  makeSubcontractCommand({
    name: "void_subcontract_pay_application",
    title: "Void Subcontract Pay Application",
    permission: "ap.create",
    action: "voidPayApplication",
    destructive: true,
    description:
      "Void a pay application when the native lifecycle allows it. Find its id and status with get_subcontract.",
    schema: z.object({ id: UUID.describe("Pay-application id.") }),
  }),
  makeSubcontractCommand({
    name: "bill_subcontract_pay_application",
    title: "Bill Subcontract Pay Application",
    permission: "ap.post",
    action: "createVendorBill",
    description:
      "Generate a vendor bill from an approved subcontract pay application. Find its id and approval state with get_subcontract; use get_record to verify the created bill.",
    schema: z.object({ id: UUID.describe("Approved pay-application id.") }),
  }),
  makeSubcontractCommand({
    name: "release_subcontract_retainage",
    title: "Release Subcontract Retainage",
    permission: "ap.post",
    action: "releaseRetainage",
    description:
      "Create a retainage release bill for an eligible subcontract balance. Find the subcontract and available retainage with get_subcontract.",
    schema: z.object({
      subcontractId: UUID.describe("Parent subcontract id."),
      periodEnd: DATE.describe("Retainage period end date."),
      amount: MONEY.describe("Exact retainage amount to release."),
      memo: z.string().max(2000).nullable().optional().describe("Optional release memo."),
    }),
  }),
  makeSubcontractCommand({
    name: "add_subcontract_payment_control",
    title: "Add Subcontract Payment Control",
    permission: "ap.pay",
    action: "addPaymentControl",
    description:
      "Add a joint-check or payment-hold control to a subcontract or pay application. Find parent and optional pay-application ids with get_subcontract.",
    schema: z.object({
      subcontractId: UUID.describe("Parent subcontract id."),
      payApplicationId: UUID.nullable().optional().describe("Optional related pay-application id."),
      vendorBillDocumentId: UUID.nullable().optional().describe("Optional related vendor-bill id."),
      controlType: z.enum(["joint_check", "payment_hold"]).describe("Payment control type."),
      jointPayeePartyId: UUID.nullable()
        .optional()
        .describe("Joint-check payee party id, when applicable."),
      amountLimit: MONEY.nullable().optional().describe("Optional exact payment cap."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Control reason recorded in the audit trail."),
      effectiveOn: DATE.describe("Control effective date."),
      expiresOn: DATE.nullable().optional().describe("Optional expiration date."),
    }),
  }),
  makeSubcontractCommand({
    name: "release_subcontract_payment_control",
    title: "Release Subcontract Payment Control",
    permission: "ap.pay",
    action: "releasePaymentControl",
    description:
      "Release an active subcontract payment hold or joint-check control with an audit reason. Find its id and status with get_subcontract.",
    schema: z.object({
      id: UUID.describe("Payment-control id."),
      releaseReason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reason for releasing the control."),
    }),
  }),
];
