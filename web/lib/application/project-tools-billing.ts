import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { BillingError } from "@openbooks/engine/documents/billing";
import { can, type Authz } from "../authz";
import { normalizeMoney } from "@openbooks/engine/money/money";
import { canonicalDecimal } from "../exact-decimal";
import { createBillingRequest, listBillingRequests } from "../billing-requests";
import { createInvoiceFromBillingRequest } from "../billing-request-invoice";
import { isFeatureEnabled } from "../features";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID returned by a project or billing-request read.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional()
  .describe("Calendar date in YYYY-MM-DD format, or null.");
const canRead = (authz: Authz) => can(authz, "projects.read");
const canManage = (authz: Authz) => can(authz, "projects.manage");
const canCreateInvoice = (authz: Authz) => can(authz, "ar.create");

async function requireProjects(context: ApplicationContext) {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "projects"))) throw notFound("project");
}

function settleBillingError(error: unknown): never {
  if (error instanceof BillingError) {
    if (
      error.message === "Billing request not found" ||
      error.message === "Inventory is disabled" ||
      error.message === "Equipment is disabled"
    ) {
      throw notFound("billing request");
    }
    throw new ApplicationError("invalid_input", error.message, 422);
  }
  if (error instanceof Error) throw invalidInput(error.message);
  throw error;
}

const requestFields = {
  projectId: UUID,
  invoiceType: z
    .enum(["progress", "final"])
    .optional()
    .describe("Progress or final invoice type; omitted uses the server's project default."),
  basis: z
    .enum(["date_range", "draw_amount", "time_selection", "milestone", "field_ticket"])
    .optional()
    .describe("WIP basis used to assemble eligible project work."),
  drawAmount: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .describe("Exact decimal draw amount, or null when not using a fixed draw."),
  startDate: DATE,
  cutoffDate: DATE,
  invoiceDescription: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe("Optional description shown on the generated invoice."),
  customerPo: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe("Optional customer purchase-order reference."),
  backupRequired: z
    .boolean()
    .optional()
    .describe("Whether the invoice requires an assembled backup packet."),
  backupType: z
    .string()
    .max(100)
    .optional()
    .describe("Configured backup packet recipe; omit to use the project policy."),
  selectedTimeEntryIds: z
    .array(UUID)
    .max(5000)
    .nullable()
    .optional()
    .describe("Selected billable time-entry ids for a time-selection basis."),
  fieldTicketIds: z
    .array(UUID)
    .max(5000)
    .nullable()
    .optional()
    .describe("Selected customer-signed field ticket ids for a field-ticket basis."),
  notes: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe("Optional internal billing-request notes."),
};

export const PROJECT_BILLING_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_project_billing_requests",
    title: "List Project Billing Requests",
    description:
      "List the project's WIP billing requests, invoice links, and backup status. Find the project id with list_records; use the returned request id to generate its invoice.",
    inputSchema: z.object({ projectId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: canRead,
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.read");
      await requireProjects(context);
      try {
        const requests = await listBillingRequests(
          context.authz.user.orgId,
          input.projectId,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, requests, href: `/projects/${input.projectId}?tab=billing` };
      } catch (error) {
        settleBillingError(error);
      }
    },
  }),
  definition({
    name: "create_project_billing_request",
    title: "Create Project Billing Request",
    description:
      "Create a WIP billing request for eligible project costs, time, milestones, or signed field tickets. Find the project with list_records, then verify it with list_project_billing_requests.",
    inputSchema: z.object({ ...requestFields, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requireProjects(context);
      let drawAmount: string | null = null;
      if (input.drawAmount != null && input.drawAmount !== "") {
        const exact = canonicalDecimal(input.drawAmount, 4);
        if (exact === null)
          throw invalidInput(
            "Draw amount must be an exact decimal with no more than four decimal places.",
          );
        try {
          drawAmount = normalizeMoney(exact);
        } catch {
          throw invalidInput(
            "Draw amount must be an exact decimal with no more than four decimal places.",
          );
        }
      }
      if (
        input.basis === "field_ticket" &&
        !(await isFeatureEnabled(context.authz.user.orgId, "fieldTickets"))
      )
        throw notFound("field ticket");
      const { idempotencyKey: _key, ...request } = input;
      try {
        const created = await createBillingRequest(
          context.authz.user.orgId,
          context.authz.user.id,
          { ...request, drawAmount },
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, ...created, href: `/projects/${input.projectId}?tab=billing` };
      } catch (error) {
        settleBillingError(error);
      }
    },
  }),
  definition({
    name: "create_invoice_from_project_wip",
    title: "Create Invoice From Project WIP",
    description:
      "Generate a draft customer invoice from an open WIP billing request and assemble any required backup packet. Find request ids with list_project_billing_requests; the request must still be billable.",
    inputSchema: z.object({ billingRequestId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canCreateInvoice,
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "ar.create");
      await requireProjects(context);
      try {
        const result = await createInvoiceFromBillingRequest({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          requestId: input.billingRequestId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          documentId: result.id,
          documentNumber: result.documentNumber,
          backup: result.backup,
          status: "draft",
          href: `/invoices/${result.id}`,
        };
      } catch (error) {
        settleBillingError(error);
      }
    },
  }),
];
