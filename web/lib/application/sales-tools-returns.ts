import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { guardSubsidiaryScope } from "../authz";
import {
  findReturnAuthorization,
  createReturnAuthorization,
  loadReturnableSources,
  loadReturnPartyScope,
  receiveReturnAuthorization,
  rejectReturnAuthorization,
  inspectReturnAuthorization,
  previewReturnRestockingFee,
  sendReturnAuthorizationEmail,
} from "../returns";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { listRecordDrawerHref } from "../cross-module-drawer-links";
import { domainUuidIdempotencyKey } from "./domain-idempotency-key";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a return, source receipt, party, account, item, or warehouse read.");
const KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const DECIMAL = z
  .string()
  .max(40)
  .describe("Exact decimal quantity or money value as text; JSON numbers are not accepted.");
const EMAIL = z
  .string()
  .max(320)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)
  .describe("Recipient email address.");
const visible = (permission: string) => (authz: Parameters<typeof can>[0]) =>
  can(authz, permission);

function settleRefusal(error: unknown): never {
  if (error instanceof Error && "status" in error && typeof error.status === "number") {
    const details: Record<string, unknown> = {};
    if ("code" in error && typeof error.code === "string") details.code = error.code;
    if ("remedy" in error && typeof error.remedy === "string") details.remedy = error.remedy;
    if (error.status === 404) throw notFound(error.message);
    if (error.status === 409) throw conflict(error.message, details);
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403, details);
    throw invalidInput(error.message, details);
  }
  throw error;
}

async function scopedReturn(
  context: Parameters<typeof assertApplicationPermission>[0],
  id: string,
) {
  const current = await findReturnAuthorization(
    context.authz.user.orgId,
    id,
    context.authz.allowedSubsidiaryIds,
  );
  if (!current) throw notFound("return authorization");
  if (
    context.authz.allowedSubsidiaryIds !== null &&
    (current.subsidiaryId === null || !context.authz.allowedSubsidiaryIds.has(current.subsidiaryId))
  ) {
    throw notFound("return authorization");
  }
  return current;
}

const lineSchema = z
  .object({
    accountId: UUID.describe("Posting account UUID for this credit line."),
    itemId: UUID.nullable().optional().describe("Optional item UUID."),
    description: z.string().nullable().optional().describe("Credit line description."),
    quantity: DECIMAL.nullable().optional().describe("Exact returned quantity."),
    unit: z.string().nullable().optional().describe("Unit of measure."),
    unitPrice: DECIMAL.nullable().optional().describe("Exact unit price."),
    amount: DECIMAL.describe("Exact credit amount."),
    taxCodeId: UUID.nullable().optional().describe("Tax code UUID, if applicable."),
    taxGroupId: UUID.nullable().optional().describe("Tax group UUID, if applicable."),
    taxOverridden: z.boolean().optional().describe("Whether tax was explicitly overridden."),
    taxAmount: DECIMAL.nullable().optional().describe("Exact tax amount."),
    stockLocationId: UUID.nullable().optional().describe("Warehouse UUID for returned stock."),
    departmentId: UUID.nullable().optional().describe("Department UUID."),
    projectId: UUID.nullable().optional().describe("Project UUID."),
    locationId: UUID.nullable().optional().describe("Location UUID."),
    classId: UUID.nullable().optional().describe("Class UUID."),
    extraDims: z
      .record(z.string(), z.string().nullable())
      .optional()
      .describe("Configured accounting dimensions."),
    custom: z.record(z.string(), z.json()).optional().describe("Optional line custom fields."),
  })
  .passthrough();

export const SALES_RETURN_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_returnable_sources",
    title: "List Returnable Sources",
    description:
      "Find posted customer shipment lines, source inventory movement ids, and lot or serial choices available for return. Provide the customer and legal entity ids from the posted source document or get_record.",
    inputSchema: z.object({
      partyId: UUID.describe("Customer party UUID from the posted source document."),
      subsidiaryId: UUID.describe("Legal entity UUID from the posted source document."),
      itemId: UUID.nullable()
        .optional()
        .describe("Optional item UUID to narrow the returned source lines."),
      stockLocationId: UUID.nullable()
        .optional()
        .describe("Optional warehouse UUID to narrow the returned source lines."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "returnAuthorizations",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      if (
        context.authz.allowedSubsidiaryIds !== null &&
        !context.authz.allowedSubsidiaryIds.has(input.subsidiaryId)
      ) {
        throw notFound("return source");
      }
      const party = await loadReturnPartyScope(context.authz.user.orgId, input.partyId);
      if (
        !party ||
        guardSubsidiaryScope(context.authz, party.subsidiaryId, { orgWideNull: true })
      ) {
        throw notFound("return source");
      }
      const sources = await loadReturnableSources({
        orgId: context.authz.user.orgId,
        partyId: input.partyId,
        subsidiaryId: input.subsidiaryId,
        itemId: input.itemId ?? undefined,
        stockLocationId: input.stockLocationId ?? undefined,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
      });
      if (!sources) throw notFound("return source");
      return { ok: true, ...sources, href: "/returns" };
    },
  }),
  definition({
    name: "authorize_return",
    title: "Authorize Return",
    description:
      "Create a return authorization for selected source-document lines and lots or serials. Use list_returnable_sources to find source movement ids and line details.",
    inputSchema: z.object({
      document: z
        .object({
          partyId: UUID.describe("Customer party UUID from the source document."),
          subsidiaryId: UUID.describe("Legal entity UUID from the source document."),
          documentDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("Return date in YYYY-MM-DD format."),
          referenceNumber: z.string().nullable().optional().describe("Customer return reference."),
          memo: z.string().nullable().optional().describe("Reason or notes for the return."),
          currency: z.string().length(3).optional().describe("Three-letter transaction currency."),
          custom: z
            .record(z.string(), z.json())
            .optional()
            .describe("Optional header custom fields."),
          lines: z
            .array(lineSchema)
            .min(1)
            .max(500)
            .describe("Credit lines describing the requested return."),
        })
        .passthrough()
        .describe("Return authorization header and draft credit lines."),
      sourceSelections: z
        .array(
          z.object({
            lineNumber: z
              .number()
              .int()
              .min(1)
              .max(500)
              .describe("Return line number corresponding to the document line."),
            sourceIssueMovementId: UUID.describe("Original inventory issue movement UUID."),
            lotId: UUID.nullable().optional().describe("Lot UUID being returned, if tracked."),
            serialId: UUID.nullable()
              .optional()
              .describe("Serial UUID being returned, if tracked."),
          }),
        )
        .min(1)
        .max(500)
        .describe("Source inventory movements selected for this authorization."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "returnAuthorizations",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      if (
        context.authz.allowedSubsidiaryIds !== null &&
        !context.authz.allowedSubsidiaryIds.has(input.document.subsidiaryId)
      ) {
        throw notFound("subsidiary");
      }
      try {
        const authorization = await createReturnAuthorization({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          key: domainUuidIdempotencyKey(context.authz.user.orgId, input.idempotencyKey),
          body: input.document,
          sourceSelections: input.sourceSelections,
          requestBody: { document: input.document, sourceSelections: input.sourceSelections },
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          doc: { id: authorization.id },
          authorization,
          href: listRecordDrawerHref("rma", authorization.id),
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "receive_return_goods",
    title: "Receive Return Goods",
    description:
      "Record how much of each authorized return line arrived. Find the return id and line ids with get_return_authorization.",
    inputSchema: z.object({
      returnId: UUID,
      lines: z
        .array(
          z.object({
            lineId: UUID,
            received: DECIMAL.describe("Exact quantity physically received."),
          }),
        )
        .min(1)
        .max(500)
        .describe("Returned line quantities received."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "returnAuthorizations",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      await scopedReturn(context, input.returnId);
      try {
        const authorization = await receiveReturnAuthorization({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          documentId: input.returnId,
          receivedLines: input.lines,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, authorization, href: listRecordDrawerHref("rma", input.returnId) };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "preview_return_restocking_fee",
    title: "Preview Return Restocking Fee",
    description:
      "Calculate the restocking fee for accepted quantities before inspecting a return. Find the return id and line ids with get_return_authorization.",
    inputSchema: z.object({
      returnId: UUID,
      lines: z
        .array(
          z.object({
            lineId: UUID,
            accepted: DECIMAL.describe("Exact quantity accepted for return."),
          }),
        )
        .min(1)
        .max(500)
        .describe("Return lines and accepted quantities."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "returnAuthorizations",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      await scopedReturn(context, input.returnId);
      try {
        const preview = await previewReturnRestockingFee({
          orgId: context.authz.user.orgId,
          documentId: input.returnId,
          lines: input.lines,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...preview, href: listRecordDrawerHref("rma", input.returnId) };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "inspect_return",
    title: "Inspect Return",
    description:
      "Record accepted quantities, dispositions, and restocking-fee waiver details; this creates the customer credit used for settlement. Find the return and line ids with get_return_authorization.",
    inputSchema: z.object({
      returnId: UUID,
      lines: z
        .array(
          z.object({
            lineId: UUID,
            accepted: DECIMAL.describe("Exact quantity accepted."),
            disposition: z
              .enum(["restock", "scrap", "vendor-return"])
              .nullable()
              .describe("Disposition for accepted goods."),
            dispositionLocationId: UUID.nullable().describe(
              "Warehouse or location for the chosen disposition.",
            ),
            vendorId: UUID.nullable()
              .optional()
              .describe("Vendor party id when disposition is vendor-return."),
          }),
        )
        .min(1)
        .max(500)
        .describe("Inspection decisions for return lines."),
      waiveFee: z
        .boolean()
        .optional()
        .describe("Whether to waive the calculated restocking fee; requires returns.waive_fee."),
      waiveReason: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe("Reason required when waiving the restocking fee."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "returnAuthorizations",
    visibleTo: (authz) => can(authz, "ar.create") && can(authz, "items.post"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ar.create");
      assertApplicationPermission(context, "items.post");
      if (input.waiveFee) assertApplicationPermission(context, "returns.waive_fee");
      await scopedReturn(context, input.returnId);
      try {
        const result = await inspectReturnAuthorization({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          documentId: input.returnId,
          inspectionLines: input.lines,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          waiveFee: input.waiveFee,
          waiveReason: input.waiveReason ?? null,
        });
        return { ok: true, ...result, href: listRecordDrawerHref("rma", input.returnId) };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "reject_return",
    title: "Reject Return",
    description:
      "Reject a return authorization that cannot be accepted and record the reason. Find the return id with get_return_authorization.",
    inputSchema: z.object({
      returnId: UUID,
      reason: z.string().min(8).max(1000).describe("Reason the return is rejected."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "returnAuthorizations",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      await scopedReturn(context, input.returnId);
      try {
        await rejectReturnAuthorization({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          documentId: input.returnId,
          reason: input.reason,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          id: input.returnId,
          status: "rejected",
          href: listRecordDrawerHref("rma", input.returnId),
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "email_return_authorization",
    title: "Email Return Authorization",
    description:
      "Send the received or inspection decision email for a return authorization to the customer's saved address or a supplied recipient. Use get_return_authorization to find its id.",
    inputSchema: z.object({
      returnId: UUID,
      type: z
        .enum(["received", "decision"])
        .describe("Email the receipt confirmation or the inspection decision."),
      to: EMAIL.optional().describe("Optional recipient email; defaults to the customer address."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    featureKey: "returnAuthorizations",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      await scopedReturn(context, input.returnId);
      try {
        const sent = await sendReturnAuthorizationEmail({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          documentId: input.returnId,
          type: input.type,
          to: input.to,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...sent, href: listRecordDrawerHref("rma", input.returnId) };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
];
