import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  listBillableFieldTickets,
  cancelBillingRequest,
  BillingRequestValidationError,
} from "../billing-requests";
import { BillingError } from "../billing";
import {
  InvoiceBackupImmutableError,
  InvoiceBackupNotFoundError,
  InvoiceBackupSourceAccessError,
} from "../invoice-backup";
import { isRendererUnavailable } from "../api/pdf-renderer";
import {
  BillingRequestAmountError,
  BillingRequestBackupNotReadyError,
  generateBillingRequestBackup,
} from "../billing-request-actions";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { listRecordDrawerHref } from "../cross-module-drawer-links";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a project, billing request, time entry, or field ticket read.");
const KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const visible = (permission: string) => (authz: Parameters<typeof can>[0]) =>
  can(authz, permission);

function settleBillingRequest(error: unknown): never {
  if (
    error instanceof BillingError &&
    ["Billing request not found", "Inventory is disabled", "Equipment is disabled"].includes(
      error.message,
    )
  )
    throw notFound("record");
  if (isRendererUnavailable(error)) {
    const message =
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
        ? error.message
        : "PDF renderer is unavailable";
    throw new ApplicationError("internal_error", message, 503);
  }
  if (
    error instanceof BillingRequestValidationError ||
    error instanceof BillingRequestAmountError ||
    error instanceof BillingRequestBackupNotReadyError ||
    error instanceof BillingError ||
    error instanceof InvoiceBackupImmutableError ||
    error instanceof InvoiceBackupNotFoundError ||
    error instanceof InvoiceBackupSourceAccessError
  ) {
    const status =
      "status" in error && typeof error.status === "number"
        ? error.status
        : error instanceof InvoiceBackupNotFoundError
          ? 404
          : error instanceof InvoiceBackupSourceAccessError
            ? 403
            : 422;
    if (status === 404) throw notFound(error.message);
    if (status === 409) throw conflict(error.message);
    if (status === 403) throw new ApplicationError("forbidden", error.message, 403);
    throw invalidInput(error.message);
  }
  if (error instanceof Error && error.message === "Project not found") throw notFound("project");
  throw error;
}

export const SALES_BILLING_REQUEST_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_billable_field_tickets",
    title: "List Billable Field Tickets",
    description:
      "Find approved field tickets that can be included in a project billing request. Find the project id with project reads.",
    inputSchema: z.object({ projectId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "projects",
    visibleTo: visible("projects.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.read");
      try {
        const fieldTickets = await listBillableFieldTickets(
          context.authz.user.orgId,
          input.projectId,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, fieldTickets, href: `/projects?project=${input.projectId}` };
      } catch (error) {
        settleBillingRequest(error);
      }
    },
  }),
  definition({
    name: "cancel_project_billing_request",
    title: "Cancel Project Billing Request",
    description:
      "Cancel an open project billing request that has not been converted to an invoice. Find the request id with list_project_billing_requests.",
    inputSchema: z.object({ requestId: UUID, idempotencyKey: KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "projects",
    visibleTo: visible("projects.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      try {
        const cancelled = await cancelBillingRequest(
          context.authz.user.orgId,
          context.authz.user.id,
          input.requestId,
          context.authz.allowedSubsidiaryIds,
        );
        return {
          ok: true,
          ...cancelled,
          status: "cancelled",
          href: `/projects?project=${cancelled.projectId}`,
        };
      } catch (error) {
        settleBillingRequest(error);
      }
    },
  }),
  definition({
    name: "generate_billing_request_backup",
    title: "Generate Billing Request Backup",
    description:
      "Assemble and persist the required PDF backup packet for a converted billing request invoice. Find the request id with list_project_billing_requests.",
    inputSchema: z.object({ requestId: UUID, idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "projects",
    visibleTo: visible("ar.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ar.create");
      try {
        const result = await generateBillingRequestBackup(
          context.authz.user.orgId,
          context.authz.user.id,
          input.requestId,
          context.authz.allowedSubsidiaryIds,
        );
        if (!result) throw notFound("billing request");
        return {
          ok: true,
          fileId: result.fileId,
          pageCount: result.pageCount,
          href: listRecordDrawerHref("customer_invoice", result.invoiceId),
        };
      } catch (error) {
        settleBillingRequest(error);
      }
    },
  }),
];
