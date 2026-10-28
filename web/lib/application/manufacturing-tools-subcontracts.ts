import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { db } from "@openbooks/engine/platform/db";
import {
  cancelProductionSubcontract,
  capitalizeSubcontractServiceBill,
  createProductionSubcontract,
  recordSubcontractReturn,
  returnSubcontractComponents,
  reverseSubcontractServiceCost,
  shipSubcontractMaterial,
} from "@openbooks/engine/manufacturing/subcontracts";
import { getWorkOrder } from "@openbooks/engine/manufacturing/work-orders";
import { ManufacturingNotFoundError } from "@openbooks/engine/manufacturing/errors";
import { subcontractBelongsToWorkOrder } from "@/lib/record-scope-reads";
import {
  assertPermission,
  assertVisibleSubsidiary,
  runManufacturing,
  UUID,
  DATE,
  DECIMAL,
  IDEMPOTENCY_KEY,
  nativeIdempotencyKey,
  recordHref,
} from "./manufacturing-tools-shared";
import { notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const POST = (authz: Parameters<typeof can>[0]) => can(authz, "items.post");

async function requireWorkOrder(context: Parameters<typeof assertPermission>[0], id: string) {
  const row = await getWorkOrder(db, context.authz.user.orgId, id);
  if (!row) throw notFound("work order");
  assertVisibleSubsidiary(context, row.subsidiaryId);
  return row;
}

async function requireSubcontract(
  context: Parameters<typeof assertPermission>[0],
  workOrderId: string,
  subcontractId: string,
) {
  await requireWorkOrder(context, workOrderId);
  if (!(await subcontractBelongsToWorkOrder(context.authz.user.orgId, subcontractId, workOrderId)))
    throw new ManufacturingNotFoundError();
}

async function authorizeSubcontractReplay(
  context: Parameters<typeof assertPermission>[0],
  workOrderId: string,
  subcontractId: string,
) {
  await runManufacturing(context, async () => {
    await requireSubcontract(context, workOrderId, subcontractId);
  });
}

export const MANUFACTURING_SUBCONTRACT_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "create_production_subcontract",
    title: "Create Production Subcontract",
    description:
      "Create a subcontract operation for a work order using its operation, vendor and custody stock location. Read the work-order routing and manufacturing options first; the order must be eligible for subcontract processing.",
    inputSchema: z.object({
      workOrderId: UUID("Work-order id from list_manufacturing_records"),
      operationId: UUID("Subcontract routing-operation id from get_manufacturing_record"),
      vendorId: UUID("Vendor id from manufacturing options"),
      custodyLocationId: UUID("Custody stock-location id from manufacturing options"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: POST,
    authorizeReplay: async (context, input) => {
      await runManufacturing(context, async () => {
        await requireWorkOrder(context, input.workOrderId);
        if (
          !(await subcontractBelongsToWorkOrder(
            context.authz.user.orgId,
            nativeIdempotencyKey(input.idempotencyKey),
            input.workOrderId,
          ))
        )
          throw new ManufacturingNotFoundError();
      });
    },
    featureKey: "manufacturingSubcontract",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.workOrderId);
        const row = await createProductionSubcontract(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          {
            id: nativeIdempotencyKey(input.idempotencyKey),
            workOrderId: input.workOrderId,
            operationId: input.operationId,
            vendorId: input.vendorId,
            custodyLocationId: input.custodyLocationId,
          },
        );
        return { ok: true, ...row, href: recordHref("work-orders", input.workOrderId) };
      });
    },
  }),
  definition({
    name: "ship_subcontract_material",
    title: "Ship Subcontract Material",
    description:
      "Send component material from an issue location into a production subcontract, retaining exact quantity and required lot or serial identity. Copy subcontract and material ids from get_production_subcontract and location ids from manufacturing options.",
    inputSchema: z.object({
      workOrderId: UUID("Work-order id from list_manufacturing_records"),
      subcontractId: UUID("Subcontract id from get_production_subcontract"),
      materialId: UUID("Material requirement id from get_manufacturing_record"),
      sourceLocationId: UUID("Source stock-location id from manufacturing options"),
      quantity: DECIMAL.describe("Exact quantity shipped as a decimal string."),
      date: DATE.describe("Shipment date."),
      lotId: UUID("Lot id from inventory tracking reads").nullable().optional(),
      serialId: UUID("Serial id from inventory tracking reads").nullable().optional(),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: POST,
    authorizeReplay: (context, input) =>
      authorizeSubcontractReplay(context, input.workOrderId, input.subcontractId),
    featureKey: "manufacturingSubcontract",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      return runManufacturing(context, async () => {
        await requireSubcontract(context, input.workOrderId, input.subcontractId);
        const row = await shipSubcontractMaterial(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.subcontractId,
          {
            id: nativeIdempotencyKey(input.idempotencyKey),
            subcontractId: input.subcontractId,
            materialId: input.materialId,
            sourceLocationId: input.sourceLocationId,
            quantity: input.quantity,
            date: input.date,
            lotId: input.lotId,
            serialId: input.serialId,
          },
        );
        return { ok: true, ...row, href: recordHref("work-orders", input.workOrderId) };
      });
    },
  }),
  definition({
    name: "record_subcontract_return",
    title: "Record Subcontract Return",
    description:
      "Record subcontracted finished output and component consumption against shipment evidence. Copy the subcontract and shipment ids from get_production_subcontract; exact quantities, completion state and actual operation times are validated by the native service.",
    inputSchema: z.object({
      workOrderId: UUID("Work-order id from list_manufacturing_records"),
      subcontractId: UUID("Subcontract id from get_production_subcontract"),
      quantity: DECIMAL.describe("Exact finished quantity returned as a decimal string."),
      finish: z.boolean().describe("Whether this return completes the subcontract operation."),
      finishReason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .nullable()
        .optional()
        .describe("Reason when the subcontract operation is being finished early."),
      consumption: z
        .array(
          z
            .object({
              shipmentId: UUID("Shipment id from get_production_subcontract"),
              quantity: DECIMAL.describe("Exact quantity consumed from this shipment."),
            })
            .strict()
            .describe("Consumption against one component shipment."),
        )
        .max(100)
        .optional()
        .describe("Component consumption allocation."),
      measuredQty: DECIMAL.nullable()
        .optional()
        .describe("Measured output quantity for quality-gated operations."),
      actualSetupMinutes: DECIMAL.nullable().optional().describe("Actual setup minutes."),
      actualRunMinutes: DECIMAL.nullable().optional().describe("Actual run minutes."),
      actualLaborMinutes: DECIMAL.nullable().optional().describe("Actual labor minutes."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: POST,
    authorizeReplay: (context, input) =>
      authorizeSubcontractReplay(context, input.workOrderId, input.subcontractId),
    featureKey: "manufacturingSubcontract",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      return runManufacturing(context, async () => {
        await requireSubcontract(context, input.workOrderId, input.subcontractId);
        const row = await recordSubcontractReturn(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.subcontractId,
          {
            id: nativeIdempotencyKey(input.idempotencyKey),
            subcontractId: input.subcontractId,
            quantity: input.quantity,
            finish: input.finish,
            finishReason: input.finishReason,
            consumption: input.consumption,
            measuredQty: input.measuredQty,
            actualSetupMinutes: input.actualSetupMinutes,
            actualRunMinutes: input.actualRunMinutes,
            actualLaborMinutes: input.actualLaborMinutes,
          },
        );
        return { ok: true, ...row, href: recordHref("work-orders", input.workOrderId) };
      });
    },
  }),
  definition({
    name: "capitalize_subcontract_service_bill",
    title: "Capitalize Subcontract Service Bill",
    description:
      "Capitalize an eligible posted vendor bill into a production subcontract's work-in-process cost. Use search_production_service_bills to find bill ids and get_production_subcontract to confirm the subcontract and work order.",
    inputSchema: z.object({
      workOrderId: UUID("Work-order id from list_manufacturing_records"),
      subcontractId: UUID("Subcontract id from get_production_subcontract"),
      billId: UUID("Bill id from search_production_service_bills"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: POST,
    authorizeReplay: (context, input) =>
      authorizeSubcontractReplay(context, input.workOrderId, input.subcontractId),
    featureKey: "manufacturingSubcontract",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      return runManufacturing(context, async () => {
        await requireSubcontract(context, input.workOrderId, input.subcontractId);
        const row = await capitalizeSubcontractServiceBill(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.subcontractId,
          input.billId,
          nativeIdempotencyKey(input.idempotencyKey),
        );
        return { ok: true, ...row, href: recordHref("work-orders", input.workOrderId) };
      });
    },
  }),
  definition({
    name: "reverse_subcontract_service_cost",
    title: "Reverse Subcontract Service Cost",
    description:
      "Reverse a previously capitalized subcontract service claim with a dated, documented adjustment. Copy the claim id from get_production_subcontract; the native service refuses claims that are already reversed or no longer eligible.",
    inputSchema: z.object({
      workOrderId: UUID("Work-order id from list_manufacturing_records"),
      subcontractId: UUID("Subcontract id from get_production_subcontract"),
      claimId: UUID("Service-cost claim id from get_production_subcontract"),
      date: DATE.describe("Date of the cost reversal."),
      reason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .describe("Reason for reversing the capitalized service cost."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: POST,
    authorizeReplay: (context, input) =>
      authorizeSubcontractReplay(context, input.workOrderId, input.subcontractId),
    featureKey: "manufacturingSubcontract",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      return runManufacturing(context, async () => {
        await requireSubcontract(context, input.workOrderId, input.subcontractId);
        const row = await reverseSubcontractServiceCost(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.subcontractId,
          input.claimId,
          input.date,
          input.reason,
        );
        return { ok: true, ...row, href: recordHref("work-orders", input.workOrderId) };
      });
    },
  }),
  definition({
    name: "return_subcontract_components",
    title: "Return Subcontract Components",
    description:
      "Return unused shipped components from subcontract custody to a stock location with a date and reason. Copy shipment ids from get_production_subcontract and confirm the return does not duplicate component consumption.",
    inputSchema: z.object({
      workOrderId: UUID("Work-order id from list_manufacturing_records"),
      subcontractId: UUID("Subcontract id from get_production_subcontract"),
      shipmentId: UUID("Shipment id from get_production_subcontract"),
      date: DATE.describe("Date unused components return to stock."),
      reason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .describe("Reason the remaining components are being returned."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: POST,
    authorizeReplay: (context, input) =>
      authorizeSubcontractReplay(context, input.workOrderId, input.subcontractId),
    featureKey: "manufacturingSubcontract",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      return runManufacturing(context, async () => {
        await requireSubcontract(context, input.workOrderId, input.subcontractId);
        const row = await returnSubcontractComponents(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.subcontractId,
          {
            id: nativeIdempotencyKey(input.idempotencyKey),
            subcontractId: input.subcontractId,
            shipmentId: input.shipmentId,
            date: input.date,
            reason: input.reason,
          },
        );
        return { ok: true, ...row, href: recordHref("work-orders", input.workOrderId) };
      });
    },
  }),
  definition({
    name: "cancel_production_subcontract",
    title: "Cancel Production Subcontract",
    description:
      "Cancel an eligible production subcontract with an audit reason. Read its shipments, returns and cost claims first; outstanding custody or posted cost evidence must be resolved by the native service before cancellation.",
    inputSchema: z.object({
      workOrderId: UUID("Work-order id from list_manufacturing_records"),
      subcontractId: UUID("Subcontract id from get_production_subcontract"),
      reason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .describe("Reason the production subcontract is cancelled."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: POST,
    authorizeReplay: (context, input) =>
      authorizeSubcontractReplay(context, input.workOrderId, input.subcontractId),
    featureKey: "manufacturingSubcontract",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      return runManufacturing(context, async () => {
        await requireSubcontract(context, input.workOrderId, input.subcontractId);
        const row = await cancelProductionSubcontract(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.subcontractId,
          input.reason,
        );
        return { ok: true, ...row, href: recordHref("work-orders", input.workOrderId) };
      });
    },
  }),
];
