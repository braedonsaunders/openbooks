import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { returnDocumentToDraft, ReturnToDraftError } from "@openbooks/engine/flows/module";
import {
  InventoryError,
  InventoryOwnershipError,
  UnitConversionError,
} from "@openbooks/engine/inventory/contracts/module";
import { WarehouseRefusal } from "@openbooks/engine/inventory/warehouses";
import { isFeatureEnabled } from "../features";
import { assignOrderLineWarehouse, ConversionError, receivePurchaseOrder } from "../order-cycle";
import { amendPurchaseOrder, PurchaseOrderAmendError } from "../purchase-order-amend";
import { confirmDropShip, dropShipRecordScope } from "../drop-ship";
import { readDocumentScope } from "../record-scope-reads";
import { convertApplicationOrder } from "./orders";
import { assertApplicationPermission, assertSubsidiaryAccess } from "./context";
import { ApplicationError, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a purchase order or one of its lines; never invent one.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date (YYYY-MM-DD).");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const DECIMAL = z
  .string()
  .regex(/^\d+(?:\.\d{1,8})?$/)
  .describe("Positive exact decimal quantity; never use a JSON number.");
const REVISION = z
  .string()
  .min(1)
  .max(100)
  .describe("Exact expectedUpdatedAt revision token copied from the order read.");

function settleOrderRefusal(error: unknown): never {
  if (error instanceof PurchaseOrderAmendError) {
    const code =
      error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : "invalid_input";
    throw new ApplicationError(code, error.message, error.status, { code: error.code });
  }
  if (error instanceof ConversionError) {
    const code =
      error.status === 404
        ? "not_found"
        : error.status === 409
          ? "conflict"
          : error.status === 403
            ? "forbidden"
            : "invalid_input";
    throw new ApplicationError(code, error.message, error.status, {
      ...(error.code ? { code: error.code } : {}),
      ...(error.details ? { details: error.details } : {}),
    });
  }
  if (error instanceof InventoryOwnershipError) {
    throw new ApplicationError("forbidden", error.message, 403);
  }
  if (error instanceof UnitConversionError) {
    throw new ApplicationError("invalid_input", error.message, error.status, error.details);
  }
  if (error instanceof WarehouseRefusal) {
    throw new ApplicationError(
      error.status === 409 ? "conflict" : "invalid_input",
      error.message,
      error.status,
      {
        code: error.code,
        remedy: error.remedy,
      },
    );
  }
  if (error instanceof InventoryError) {
    throw new ApplicationError("invalid_input", error.message, 422);
  }
  if (error instanceof Error && error.name === "ReturnToDraftError") {
    const refusal = error as Error & { status?: number; code?: string };
    const status = refusal.status ?? 422;
    const code = status === 404 ? "not_found" : status === 409 ? "conflict" : "invalid_input";
    throw new ApplicationError(
      code,
      error.message,
      status,
      refusal.code ? { code: refusal.code } : undefined,
    );
  }
  if (error instanceof Error && error.name === "DropShipRefusal") {
    const refusal = error as Error & { status?: number; code?: string; remedy?: string };
    const status = refusal.status ?? 422;
    const code = status === 404 ? "not_found" : status === 409 ? "conflict" : "invalid_input";
    throw new ApplicationError(code, error.message, status, {
      ...(refusal.code ? { code: refusal.code } : {}),
      ...(refusal.remedy ? { remedy: refusal.remedy } : {}),
    });
  }
  throw error;
}

export const PURCHASING_ORDER_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "bill_purchase_order",
    title: "Bill Purchase Order",
    description:
      "Convert an issued purchase order into a vendor bill for its unbilled lines, using the native order conversion and three-way matching rules. Find the order and revision with search_orders or get_record.",
    inputSchema: z.object({
      documentId: UUID,
      expectedUpdatedAt: REVISION,
      creditOverrideReason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .optional()
        .describe("Reason for any governed credit override."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "purchase_orders.read") && can(authz, "ap.create"),
    featureKey: "orders",
    execute: async (context, input) => {
      assertApplicationPermission(context, "purchase_orders.read");
      const outcome = await convertApplicationOrder(context, {
        documentId: input.documentId,
        expectedKind: "purchase_order",
        targetKind: "vendor_bill",
        expectedUpdatedAt: input.expectedUpdatedAt,
        creditOverrideReason: input.creditOverrideReason,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        ok: true,
        ...outcome.result,
        href: `/ap/bills?bill=${outcome.result.id}`,
      };
    },
  }),
  definition({
    name: "receive_purchase_order",
    title: "Receive Purchase Order",
    description:
      "Record an explicit receipt against an issued purchase order; quantities must be exact decimals and the order must be readable in your subsidiary scope. Find line ids with get_record.",
    inputSchema: z.object({
      documentId: UUID,
      receiptDate: DATE,
      lines: z
        .array(z.object({ sourceLineId: UUID, quantity: DECIMAL }))
        .min(1)
        .max(500)
        .describe("Purchase-order lines and quantities received now."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "goods_receipts.create"),
    featureKey: "orders",
    execute: async (context, input) => {
      assertApplicationPermission(context, "goods_receipts.create");
      const orgId = context.authz.user.orgId;
      if (!(await isFeatureEnabled(orgId, "inventory"))) throw notFound("record");
      if (!(await isFeatureEnabled(orgId, "orders"))) throw notFound("record");
      assertApplicationPermission(context, "items.post");
      const source = await readDocumentScope(orgId, input.documentId, { kind: "purchase_order" });
      if (!source) throw notFound("record");
      assertSubsidiaryAccess(context, source.subsidiaryId);
      try {
        const receipt = await receivePurchaseOrder(orgId, context.authz.user.id, input.documentId, {
          receiptDate: input.receiptDate,
          lines: input.lines,
          idempotencyKey: input.idempotencyKey,
        });
        return { ok: true, ...receipt, href: `/receipts?receipt=${receipt.id}` };
      } catch (error) {
        settleOrderRefusal(error);
      }
    },
  }),
  definition({
    name: "assign_purchase_order_warehouse",
    title: "Assign Purchase Order Warehouse",
    description:
      "Assign a warehouse to one line of an approved purchase order that needs a receiving location. Copy the line id and expectedUpdatedAt from get_record.",
    inputSchema: z.object({
      documentId: UUID,
      lineId: UUID,
      stockLocationId: UUID,
      expectedUpdatedAt: REVISION,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "purchase_orders.create"),
    featureKey: "orders",
    execute: async (context, input) => {
      assertApplicationPermission(context, "purchase_orders.create");
      const orgId = context.authz.user.orgId;
      if (!(await isFeatureEnabled(orgId, "orders"))) throw notFound("record");
      const source = await readDocumentScope(orgId, input.documentId, { kind: "purchase_order" });
      if (!source) throw notFound("record");
      assertSubsidiaryAccess(context, source.subsidiaryId);
      try {
        const assignment = await assignOrderLineWarehouse({
          orgId,
          userId: context.authz.user.id,
          orderId: input.documentId,
          kind: "purchase_order",
          lineId: input.lineId,
          stockLocationId: input.stockLocationId,
          expectedUpdatedAt: input.expectedUpdatedAt,
        });
        return { ok: true, ...assignment, href: `/purchase-orders?order=${input.documentId}` };
      } catch (error) {
        settleOrderRefusal(error);
      }
    },
  }),
  definition({
    name: "amend_purchase_order",
    title: "Amend Purchase Order",
    description:
      "Change quantities or unit prices on an approved purchase order with a recorded reason; the order re-enters its native approval flow. Find current lines and revision with get_record.",
    inputSchema: z.object({
      documentId: UUID,
      reason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .describe("Business reason recorded with the amendment."),
      expectedUpdatedAt: REVISION,
      lines: z
        .array(
          z.object({
            lineId: UUID,
            quantity: DECIMAL.optional().describe("Replacement ordered quantity."),
            unitPrice: z
              .string()
              .regex(/^\d+(?:\.\d{1,4})?$/)
              .optional()
              .describe("Replacement exact unit price."),
          }),
        )
        .min(1)
        .max(500)
        .describe("Lines to amend; include only values being changed."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "purchase_orders.create"),
    featureKey: "orders",
    execute: async (context, input) => {
      assertApplicationPermission(context, "purchase_orders.create");
      const orgId = context.authz.user.orgId;
      if (!(await isFeatureEnabled(orgId, "orders"))) throw notFound("record");
      try {
        const result = await amendPurchaseOrder({
          orderId: input.documentId,
          orgId,
          actorId: context.authz.user.id,
          reason: input.reason,
          expectedUpdatedAt: input.expectedUpdatedAt,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          lines: input.lines,
        });
        return {
          ok: true,
          id: input.documentId,
          ...result,
          href: `/purchase-orders?order=${input.documentId}`,
        };
      } catch (error) {
        settleOrderRefusal(error);
      }
    },
  }),
  definition({
    name: "return_purchase_order_to_draft",
    title: "Return Purchase Order to Draft",
    description:
      "Withdraw an approved, unapplied purchase order to draft with an audit reason so it can be edited and resubmitted. Find its revision with get_record.",
    inputSchema: z.object({
      documentId: UUID,
      reason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .describe("Reason for withdrawing the approved order."),
      expectedUpdatedAt: REVISION,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "purchase_orders.create"),
    featureKey: "orders",
    execute: async (context, input) => {
      assertApplicationPermission(context, "purchase_orders.create");
      const orgId = context.authz.user.orgId;
      if (!(await isFeatureEnabled(orgId, "orders"))) throw notFound("record");
      const source = await readDocumentScope(orgId, input.documentId, { kind: "purchase_order" });
      if (!source) throw notFound("record");
      assertSubsidiaryAccess(context, source.subsidiaryId);
      try {
        const result = await returnDocumentToDraft({
          documentId: input.documentId,
          orgId,
          actorId: context.authz.user.id,
          reason: input.reason,
          expectedUpdatedAt: input.expectedUpdatedAt,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          id: input.documentId,
          ...result,
          href: `/purchase-orders?order=${input.documentId}`,
        };
      } catch (error) {
        if (error instanceof ReturnToDraftError) settleOrderRefusal(error);
        throw error;
      }
    },
  }),
  definition({
    name: "confirm_drop_ship_shipment",
    title: "Confirm Drop-Ship Shipment",
    description:
      "Confirm quantities the vendor shipped directly to the customer against an approved drop-ship purchase order; this creates the receipt and fulfillment through the native inventory path. Find its purchase-order lines with get_record.",
    inputSchema: z.object({
      purchaseOrderId: UUID,
      confirmationDate: DATE.optional().describe(
        "Vendor shipment date; defaults to business today.",
      ),
      lines: z
        .array(z.object({ purchaseOrderLineId: UUID, quantity: DECIMAL }))
        .min(1)
        .max(500)
        .describe("Purchase-order lines and quantities shipped by the vendor."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "items.post"),
    featureKey: "dropShipping",
    execute: async (context, input) => {
      const scope = await dropShipRecordScope(
        context.authz.user.orgId,
        input.purchaseOrderId,
        "purchase_order",
      );
      if (!scope) throw notFound("record");
      assertSubsidiaryAccess(context, scope.subsidiaryId);
      try {
        const result = await confirmDropShip(context, input);
        return { ok: true, ...result, href: `/purchase-orders?order=${input.purchaseOrderId}` };
      } catch (error) {
        settleOrderRefusal(error);
      }
    },
  }),
];
