import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { can } from "../authz";
import { db } from "@openbooks/engine/platform/db";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { estimateConversionPermission } from "@openbooks/engine/organization/permissions";
import { cancelOrderLineRemainder, salesOrderScope } from "@openbooks/engine/sales/backorders";
import { ConversionError } from "../order-cycle-shared";
import {
  convertOrder,
  assignOrderLineWarehouse,
  conversionWouldCopyInventoryKinds,
} from "../order-cycle";
import { createDropShipPurchaseOrder, routeSalesOrderLine } from "../drop-ship";
import { AgencyError, proposeDropShipAssessment } from "@openbooks/engine/inventory";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { isFeatureEnabled } from "../features";
import { assertApplicationPermission } from "./context";
import type { ApplicationContext } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { listRecordDrawerHref } from "../cross-module-drawer-links";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a sales-order, quote, warehouse, or line read.");
const KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const visible = (permission: string) => (authz: Parameters<typeof can>[0]) =>
  can(authz, permission);

function settleConversion(error: unknown): never {
  if (error instanceof ConversionError) {
    const details =
      error.details && typeof error.details === "object"
        ? (error.details as Record<string, unknown>)
        : undefined;
    if (error.status === 404) throw notFound(error.message);
    if (error.status === 409) throw conflict(error.message, details);
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403, details);
    throw invalidInput(error.message, details);
  }
  throw error;
}

function settleDomainRefusal(error: unknown): never {
  if (error instanceof Error && "status" in error && typeof error.status === "number") {
    const status = error.status;
    const details =
      "remedy" in error && typeof error.remedy === "string" ? { remedy: error.remedy } : undefined;
    if (status === 404) throw notFound(error.message);
    if (status === 409) throw conflict(error.message, details);
    if (status === 403) throw new ApplicationError("forbidden", error.message, 403, details);
    throw invalidInput(error.message, details);
  }
  throw error;
}

async function assertOrderScope(
  context: ApplicationContext,
  id: string,
  kind: "quote" | "sales_order",
) {
  const row = (
    await db.execute<{ subsidiary_id: string | null }>(
      sql`
    select subsidiary_id from documents where org_id = ${context.authz.user.orgId} and id = ${id} and kind = ${kind}
  `,
      "objects",
    )
  )[0];
  if (!row) throw notFound(kind === "quote" ? "quote" : "sales order");
  if (
    context.authz.allowedSubsidiaryIds !== null &&
    (row.subsidiary_id === null || !context.authz.allowedSubsidiaryIds.has(row.subsidiary_id))
  ) {
    throw notFound(kind === "quote" ? "quote" : "sales order");
  }
}

function quoteConversionTool(
  targetKind: "sales_order" | "customer_invoice",
): ApplicationToolDefinition {
  const label = targetKind === "sales_order" ? "Sales Order" : "Customer Invoice";
  return definition({
    name:
      targetKind === "sales_order"
        ? "convert_quote_to_sales_order"
        : "convert_quote_to_customer_invoice",
    title: `Convert Quote To ${label}`,
    description: `Convert an issued quote into a ${label.toLowerCase()}, copying only its unconverted quantities. Read the quote with get_record first and pass its current revision.`,
    inputSchema: z.object({
      quoteId: UUID.describe("Issued quote UUID from get_record."),
      expectedUpdatedAt: z
        .string()
        .min(1)
        .max(100)
        .describe("Exact revision token copied from get_record."),
      creditOverrideReason: z
        .string()
        .max(1000)
        .optional()
        .describe("Reason required when overriding a credit refusal."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "orders",
    visibleTo: (authz) =>
      can(authz, "estimates.create") &&
      can(authz, "estimates.read") &&
      can(authz, estimateConversionPermission(targetKind)),
    execute: async (context, input) => {
      assertApplicationPermission(context, "estimates.create");
      assertApplicationPermission(context, "estimates.read");
      assertApplicationPermission(context, estimateConversionPermission(targetKind));
      await assertOrderScope(context, input.quoteId, "quote");
      if (await conversionWouldCopyInventoryKinds(context.authz.user.orgId, input.quoteId))
        throw notFound("quote");
      try {
        const result = await convertOrder(
          context.authz.user.orgId,
          context.authz.user.id,
          input.quoteId,
          targetKind,
          {
            expectedUpdatedAt: input.expectedUpdatedAt,
            creditOverrideReason: input.creditOverrideReason,
          },
        );
        const target = targetKind === "sales_order" ? "sales_order" : "customer_invoice";
        return { ok: true, ...result, href: listRecordDrawerHref(target, result.id) };
      } catch (error) {
        settleConversion(error);
      }
    },
  });
}

function salesOrderConversionTool(
  targetKind: "customer_invoice" | "sales_fulfillment",
): ApplicationToolDefinition {
  const label = targetKind === "customer_invoice" ? "Customer Invoice" : "Sales Fulfillment";
  return definition({
    name:
      targetKind === "customer_invoice"
        ? "convert_sales_order_to_customer_invoice"
        : "create_sales_fulfillment_from_order",
    title:
      targetKind === "customer_invoice"
        ? "Convert Sales Order To Customer Invoice"
        : "Create Sales Fulfillment From Order",
    description: `Convert an issued sales order into a ${label.toLowerCase()} using its remaining quantities. Read the order with get_record first and pass its current revision.`,
    inputSchema: z.object({
      salesOrderId: UUID.describe("Issued sales-order UUID from get_record."),
      expectedUpdatedAt: z
        .string()
        .min(1)
        .max(100)
        .describe("Exact revision token copied from get_record."),
      creditOverrideReason: z
        .string()
        .max(1000)
        .optional()
        .describe("Reason required when overriding a credit refusal."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "orders",
    visibleTo: (authz) => can(authz, "ar.read") && can(authz, "ar.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ar.read");
      assertApplicationPermission(context, "ar.create");
      if (
        targetKind === "sales_fulfillment" &&
        (await isFeatureEnabled(context.authz.user.orgId, "inventory"))
      ) {
        assertApplicationPermission(context, "items.post");
      }
      await assertOrderScope(context, input.salesOrderId, "sales_order");
      if (await conversionWouldCopyInventoryKinds(context.authz.user.orgId, input.salesOrderId))
        throw notFound("sales order");
      try {
        const result = await convertOrder(
          context.authz.user.orgId,
          context.authz.user.id,
          input.salesOrderId,
          targetKind,
          {
            expectedUpdatedAt: input.expectedUpdatedAt,
            creditOverrideReason: input.creditOverrideReason,
          },
        );
        const target = targetKind === "customer_invoice" ? "customer_invoice" : "shipment";
        return {
          ok: true,
          ...result,
          href: listRecordDrawerHref(target, result.id),
        };
      } catch (error) {
        settleConversion(error);
      }
    },
  });
}

export const SALES_ORDER_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  quoteConversionTool("sales_order"),
  quoteConversionTool("customer_invoice"),
  salesOrderConversionTool("customer_invoice"),
  salesOrderConversionTool("sales_fulfillment"),
  definition({
    name: "assign_order_line_warehouse",
    title: "Assign Order Line Warehouse",
    description:
      "Route an approved sales-order line to an active warehouse before fulfillment. Find the order and exact revision with get_record, then provide the line and warehouse ids.",
    inputSchema: z.object({
      salesOrderId: UUID.describe("Approved sales-order UUID from get_record."),
      lineId: UUID.describe("Sales-order line UUID from get_record."),
      stockLocationId: UUID.describe("Active warehouse UUID from the warehouse read tools."),
      expectedUpdatedAt: z
        .string()
        .min(1)
        .max(100)
        .describe("Exact revision token copied from get_record."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "orders",
    visibleTo: visible("ar.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ar.create");
      await assertOrderScope(context, input.salesOrderId, "sales_order");
      try {
        const result = await assignOrderLineWarehouse({
          orgId: context.authz.user.orgId,
          userId: context.authz.user.id,
          orderId: input.salesOrderId,
          kind: "sales_order",
          lineId: input.lineId,
          stockLocationId: input.stockLocationId,
          expectedUpdatedAt: input.expectedUpdatedAt,
        });
        return {
          ok: true,
          ...result,
          href: listRecordDrawerHref("sales_order", input.salesOrderId),
        };
      } catch (error) {
        settleConversion(error);
      }
    },
  }),
  definition({
    name: "cancel_order_backorder_quantity",
    title: "Cancel Backordered Quantity",
    description:
      "Cancel an unfulfilled quantity on an issued sales-order line with an audit reason. Use get_record or get_backorder_position to find the order and line ids.",
    inputSchema: z.object({
      salesOrderId: UUID.describe("Sales-order UUID from get_record."),
      lineId: UUID.describe("Open sales-order line UUID from get_backorder_position."),
      quantity: z.string().min(1).max(40).describe("Exact decimal quantity text to cancel."),
      reason: z
        .string()
        .min(1)
        .max(1000)
        .describe("Business reason for cancelling the open quantity."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "fulfillment",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      const order = await salesOrderScope(db, context.authz.user.orgId, input.salesOrderId);
      if (!order) throw notFound("sales order");
      if (
        context.authz.allowedSubsidiaryIds !== null &&
        (order.subsidiaryId === null || !context.authz.allowedSubsidiaryIds.has(order.subsidiaryId))
      ) {
        throw notFound("sales order");
      }
      try {
        const result = await db.transaction((tx) =>
          cancelOrderLineRemainder(tx, context.authz.user.orgId, context.authz.user.id, {
            documentId: order.id,
            lineId: input.lineId,
            quantity: input.quantity,
            reason: input.reason,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          }),
        );
        return {
          ok: true,
          ...result,
          href: listRecordDrawerHref("sales_order", input.salesOrderId),
        };
      } catch (error) {
        settleDomainRefusal(error);
      }
    },
  }),
  definition({
    name: "route_sales_order_drop_ship_line",
    title: "Route Drop Ship Line",
    description:
      "Route or unroute an eligible sales-order line through its vendor for drop shipping. Use get_record to find the order and line ids.",
    inputSchema: z.object({
      salesOrderId: UUID.describe("Sales-order UUID from get_record."),
      salesOrderLineId: UUID.describe("Sales-order line UUID from get_record."),
      routed: z
        .boolean()
        .describe("true routes the line for drop shipping; false removes the route."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "dropShipping",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      try {
        const result = await routeSalesOrderLine(context, input);
        return {
          ok: true,
          ...result,
          href: listRecordDrawerHref("sales_order", input.salesOrderId),
        };
      } catch (error) {
        settleDomainRefusal(error);
      }
    },
  }),
  definition({
    name: "create_drop_ship_purchase_order",
    title: "Create Drop Ship Purchase Order",
    description:
      "Create a vendor purchase order for routed sales-order lines. The sales order must be issued and have eligible routed lines; use get_record to find its id and list parties to find the vendor.",
    inputSchema: z.object({
      salesOrderId: UUID.describe("Issued sales-order UUID from get_record."),
      vendorId: UUID.describe("Active vendor party UUID from list_records."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "dropShipping",
    visibleTo: visible("ap.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ap.create");
      try {
        const result = await createDropShipPurchaseOrder(context, input);
        return { ok: true, ...result, href: listRecordDrawerHref("purchase_order", result.id) };
      } catch (error) {
        settleDomainRefusal(error);
      }
    },
  }),
  definition({
    name: "propose_drop_ship_control_assessment",
    title: "Propose Drop Ship Control Assessment",
    description:
      "Record whether the company controls goods before transfer to the customer for an approved linked drop ship order. Read the sales order and its routed line first; approval of the proposal is handled by the financial change workflow.",
    inputSchema: z.object({
      salesOrderLineId: UUID.describe("Routed sales-order line UUID from get_record."),
      controlsBeforeTransfer: z
        .boolean()
        .describe("Whether the company controls the goods before transfer to the customer."),
      passThroughAccountId: UUID.nullable().describe(
        "Vendor pass-through liability account when the company does not control the goods; otherwise null.",
      ),
      controlEvidence: z
        .string()
        .min(40)
        .max(10000)
        .describe("Contractual evidence supporting the control assessment."),
      effectiveOn: z
        .string()
        .regex(/^\\d{4}-\\d{2}-\\d{2}$/)
        .describe("Effective date in YYYY-MM-DD format."),
      reason: z.string().min(8).max(1000).describe("Reason for the accounting assessment."),
      idempotencyKey: z
        .string()
        .min(1)
        .max(120)
        .describe("Unique retry key for this exact proposal."),
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "dropShipping",
    visibleTo: visible("ar.post"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ar.post");
      try {
        const source = (
          await db.execute<{ orderId: string }>(
            sql`
          select d.id as "orderId"
            from document_lines l join documents d on d.org_id = l.org_id and d.id = l.document_id
           where l.org_id = ${context.authz.user.orgId} and l.id = ${input.salesOrderLineId} and d.kind = 'sales_order'
        `,
            "objects",
          )
        )[0];
        if (!source) throw notFound("sales order line");
        const { idempotencyKey: _key, ...body } = input;
        const id = await proposeDropShipAssessment(
          context.authz.user.orgId,
          context.authz.user.id,
          { ...body, idempotencyKey: input.idempotencyKey },
        );
        return {
          ok: true,
          id,
          status: "proposed",
          href: listRecordDrawerHref("sales_order", source.orderId),
        };
      } catch (error) {
        if (error instanceof AgencyError) throw invalidInput(error.message);
        if (error instanceof ScopeNotFoundError) throw notFound("sales order line");
        throw error;
      }
    },
  }),
];
