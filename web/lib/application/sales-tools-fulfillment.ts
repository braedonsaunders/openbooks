import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { can } from "../authz";
import { db } from "@openbooks/engine/platform/db";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  createPickList,
  createShipment,
  fulfillmentDocumentScope,
  getFulfillmentDocument,
  releasePickList,
  setShipmentCarrier,
  setShipmentCartons,
  voidPickList,
  voidShipment,
} from "@openbooks/engine/sales/fulfillment/module";
import {
  buyShipmentLabel,
  getShipmentRates,
  refreshLabelTracking,
  validateShipmentAddress,
  voidShipmentLabel,
} from "@openbooks/engine/sales/shipping-labels";
import {
  suggestPickConfirmation,
  releasePickWave,
  setPickDispatchPolicy,
} from "@openbooks/engine/sales/pick-execution";
import {
  createHandlingUnit,
  getHandlingUnits,
  handlingUnitBinOptions,
  sealHandlingUnit,
  moveHandlingUnit,
} from "@openbooks/engine/sales/handling-units";
import {
  confirmExecutionTask,
  executionTaskView,
} from "@openbooks/engine/inventory/directed-execution";
import { executePickDirection } from "@openbooks/engine/sales/pick-execution";
import {
  suggestPackConfirmation,
  executePackDirection,
} from "@openbooks/engine/sales/handling-units";
import { withOrgTransaction } from "@openbooks/engine/platform/database";
import { releasePickWaveInput, setPickDispatchPolicyInput } from "../api/pick-wave";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { listRecordDrawerHref } from "../cross-module-drawer-links";
import { completeShipment, saveFulfillmentCustom, sendShipmentTracking } from "../shipments";
import { salesOrderScope } from "@openbooks/engine/sales/backorders";
import { executionActionBody, executionKey } from "../api/warehouse-execution";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a sales order, pick list, shipment, line, bin, or carrier read.");
const KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const EMAIL = z
  .string()
  .max(320)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)
  .describe("Recipient email address.");
const visible = (permission: string) => (authz: Parameters<typeof can>[0]) =>
  can(authz, permission);
const fulfillmentPickActionSchema = executionActionBody;
const fulfillmentPickScanInputSchema = z.object({
  item: z.string().min(1).max(200).describe("Scanned item identifier or barcode."),
  bin: z.string().min(1).max(200).describe("Scanned bin identifier or barcode."),
  quantity: z.string().max(40).describe("Exact decimal quantity confirmed."),
  lot: z.string().min(1).max(200).optional().describe("Scanned lot identifier when required."),
  serial: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Scanned serial identifier when required."),
});
const fulfillmentPickInputSchema = z
  .object({
    action: z.enum(["confirm", "pick", "pack"]).describe("Warehouse execution action."),
    taskId: UUID.optional().describe("Execution task UUID for a confirm action."),
    scan: fulfillmentPickScanInputSchema
      .optional()
      .describe("Optional scan evidence for a confirm action."),
    lineId: UUID.optional().describe("Execution line UUID for a pick or pack suggestion."),
    quantity: z.string().max(40).optional().describe("Exact decimal quantity for a pick."),
    reason: z.string().max(500).optional().describe("Reason for a short pick."),
    unitId: UUID.optional().describe("Handling unit UUID for a pack suggestion."),
    commandKey: executionKey.optional().describe("Stable warehouse command key for pick or pack."),
    idempotencyKey: KEY,
  })
  .superRefine((input, issueContext) => {
    const { idempotencyKey: _key, ...actionInput } = input;
    const parsed = fulfillmentPickActionSchema.safeParse(actionInput);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issueContext.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
    }
  });
const handlingUnitActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create").describe("Create a carton handling unit."),
    shipmentId: UUID,
    code: z.string().min(1).max(60).describe("Unique carton code."),
    binId: UUID,
    lineIds: z.array(UUID).min(1).max(500).describe("Shipment line ids assigned to this carton."),
  }),
  z.object({ action: z.literal("seal").describe("Seal a packed handling unit."), unitId: UUID }),
  z.object({
    action: z.literal("move").describe("Move a handling unit to another bin."),
    unitId: UUID,
    toBinId: UUID,
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("Move date in YYYY-MM-DD format."),
    reason: z.string().min(5).max(500).describe("Reason for moving the handling unit."),
    commandKey: executionKey,
  }),
]);
const handlingUnitInputSchema = z
  .object({
    action: z.enum(["create", "seal", "move"]).describe("Handling-unit action to perform."),
    shipmentId: UUID.optional().describe("Shipment UUID for a create action."),
    code: z.string().min(1).max(60).optional().describe("Unique carton code for a create action."),
    binId: UUID.optional().describe("Packing bin UUID for a create action."),
    lineIds: z
      .array(UUID)
      .min(1)
      .max(500)
      .optional()
      .describe("Shipment line ids assigned to a carton."),
    unitId: UUID.optional().describe("Handling unit UUID for a seal or move action."),
    toBinId: UUID.optional().describe("Destination bin UUID for a move action."),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Move date in YYYY-MM-DD format."),
    reason: z.string().min(5).max(500).optional().describe("Reason for moving the handling unit."),
    commandKey: executionKey.optional().describe("Stable warehouse command key for a move."),
    idempotencyKey: KEY,
  })
  .superRefine((input, issueContext) => {
    const { idempotencyKey: _key, ...actionInput } = input;
    const parsed = handlingUnitActionSchema.safeParse(actionInput);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issueContext.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
    }
  });

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

async function scopedDocument(
  context: Parameters<typeof assertApplicationPermission>[0],
  id: string,
  kind: "pick_list" | "shipment",
) {
  const scope = await fulfillmentDocumentScope(db, context.authz.user.orgId, id, kind);
  if (!scope) throw notFound(kind === "pick_list" ? "pick list" : "shipment");
  assertVisibleSubsidiary(
    context,
    scope.subsidiaryId,
    kind === "pick_list" ? "pick list" : "shipment",
  );
}

function assertVisibleSubsidiary(
  context: Parameters<typeof assertApplicationPermission>[0],
  subsidiaryId: string | null,
  resource: string,
): void {
  if (
    context.authz.allowedSubsidiaryIds !== null &&
    (subsidiaryId === null || !context.authz.allowedSubsidiaryIds.has(subsidiaryId))
  ) {
    throw notFound(resource);
  }
}

async function shipmentForLabel(
  context: Parameters<typeof assertApplicationPermission>[0],
  labelId: string,
): Promise<string> {
  const label = (
    await db.execute<{ shipmentId: string; subsidiaryId: string | null }>(
      sql`
        select l.shipment_document_id as "shipmentId", d.subsidiary_id as "subsidiaryId"
          from shipment_labels l
          join documents d on d.org_id = l.org_id and d.id = l.shipment_document_id and d.kind = 'shipment'
         where l.org_id = ${context.authz.user.orgId} and l.id = ${labelId}
      `,
      "objects",
    )
  )[0];
  if (!label) throw notFound("shipment label");
  assertVisibleSubsidiary(context, label.subsidiaryId, "shipment label");
  return label.shipmentId;
}

async function shipmentForHandlingUnit(
  context: Parameters<typeof assertApplicationPermission>[0],
  unitId: string,
): Promise<string> {
  const unit = (
    await db.execute<{ shipmentId: string; subsidiaryId: string | null }>(
      sql`
        select unit.shipment_document_id as "shipmentId", doc.subsidiary_id as "subsidiaryId"
          from handling_units unit
          join documents doc on doc.org_id = unit.org_id and doc.id = unit.shipment_document_id
         where unit.org_id = ${context.authz.user.orgId} and unit.id = ${unitId} and doc.kind = 'shipment'
      `,
      "objects",
    )
  )[0];
  if (!unit) throw notFound("handling unit");
  assertVisibleSubsidiary(context, unit.subsidiaryId, "handling unit");
  return unit.shipmentId;
}

export const SALES_FULFILLMENT_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "create_pick_list",
    title: "Create Pick List",
    description:
      "Create a draft pick list reserving bins for an issued sales order. Use get_record and get_backorder_position to find order lines, then use inventory reads to choose bins.",
    inputSchema: z.object({
      salesOrderId: UUID,
      documentDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Pick-list date in YYYY-MM-DD format; defaults to the business date."),
      memo: z.string().max(2000).nullable().optional().describe("Optional pick-list memo."),
      lines: z
        .array(
          z.object({
            salesOrderLineId: UUID,
            binId: UUID.describe("Stock bin UUID from inventory availability."),
            quantity: z.string().max(40).describe("Exact decimal quantity to pick."),
            lotId: UUID.nullable().optional().describe("Lot UUID when selecting a specific lot."),
            serialId: UUID.nullable()
              .optional()
              .describe("Serial UUID when selecting a specific serialized item."),
            kitComponentItemId: UUID.nullable()
              .optional()
              .describe("Component item UUID when picking a kit component."),
          }),
        )
        .min(1)
        .max(500)
        .describe("Order lines and the bins, lots, or serials to pick."),
      custom: z
        .record(z.string(), z.json())
        .optional()
        .describe("Optional header custom-field values."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "fulfillment",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      const order = await salesOrderScope(db, context.authz.user.orgId, input.salesOrderId);
      if (!order) throw notFound("sales order");
      assertVisibleSubsidiary(context, order.subsidiaryId, "sales order");
      try {
        const { custom, idempotencyKey: _key, ...body } = input;
        const pickList = await db.transaction(async (tx) => {
          const created = await createPickList(
            tx,
            context.authz.user.orgId,
            context.authz.user.id,
            {
              ...body,
              allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
            },
          );
          if (custom)
            await saveFulfillmentCustom(tx, context.authz.user.orgId, context.authz.user.id, {
              documentId: created.id,
              kind: "pick_list",
              custom,
            });
          return created;
        });
        return { ok: true, pickList, href: listRecordDrawerHref("pick_list", pickList.id) };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "release_pick_list",
    title: "Release Pick List",
    description:
      "Release a draft pick list through its configured approval flow and reserve its bins. Find the pick-list id with list_pick_lists.",
    inputSchema: z.object({ pickListId: UUID, idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "fulfillment",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      await scopedDocument(context, input.pickListId, "pick_list");
      try {
        const pickList = await releasePickList(context.authz.user.orgId, context.authz.user.id, {
          pickListId: input.pickListId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, pickList, href: listRecordDrawerHref("pick_list", input.pickListId) };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "void_pick_list",
    title: "Void Pick List",
    description:
      "Void a draft or released pick list with a reason so it no longer holds bins. Find the pick-list id with list_pick_lists.",
    inputSchema: z.object({
      pickListId: UUID,
      reason: z.string().max(1000).describe("Reason for voiding the pick list."),
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
      await scopedDocument(context, input.pickListId, "pick_list");
      try {
        await db.transaction((tx) =>
          voidPickList(tx, context.authz.user.orgId, context.authz.user.id, {
            pickListId: input.pickListId,
            reason: input.reason,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          }),
        );
        return {
          ok: true,
          id: input.pickListId,
          status: "voided",
          href: listRecordDrawerHref("pick_list", input.pickListId),
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "create_shipment_from_pick_list",
    title: "Create Shipment From Pick List",
    description:
      "Create a draft shipment from a released, open pick list. Find pick-list ids with list_pick_lists and use its shipment lines for quantities and cartons.",
    inputSchema: z.object({
      pickListId: UUID,
      documentDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Shipment date in YYYY-MM-DD format."),
      memo: z.string().max(2000).nullable().optional().describe("Optional shipment memo."),
      lines: z
        .array(
          z.object({
            pickLineId: UUID,
            quantity: z
              .string()
              .max(40)
              .describe("Exact decimal quantity to ship from this pick line."),
            carton: z.string().max(60).nullable().optional().describe("Optional carton code."),
          }),
        )
        .min(1)
        .max(500)
        .optional()
        .describe("Pick lines to ship; omit to ship each pick line in full."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "fulfillment",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      await scopedDocument(context, input.pickListId, "pick_list");
      try {
        const { idempotencyKey: _key, ...body } = input;
        const shipment = await db.transaction((tx) =>
          createShipment(tx, context.authz.user.orgId, context.authz.user.id, {
            ...body,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          }),
        );
        return { ok: true, shipment, href: listRecordDrawerHref("shipment", shipment.id) };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "update_draft_shipment_routing",
    title: "Update Draft Shipment Routing",
    description:
      "Set a draft shipment's carrier, service, tracking number, carton assignments, or custom fields. Find the shipment with get_shipment; completed shipments cannot be edited.",
    inputSchema: z
      .object({
        shipmentId: UUID,
        carrier: z
          .object({
            carrierId: UUID,
            service: z.string().max(100).describe("Service offered by the selected carrier."),
            trackingNumber: z
              .string()
              .max(100)
              .nullable()
              .optional()
              .describe("Carrier tracking number, if already assigned."),
          })
          .optional()
          .describe("Carrier selection for the shipment."),
        cartons: z
          .array(
            z.object({
              lineId: UUID.describe("Shipment-line UUID from get_shipment."),
              carton: z.string().max(60).nullable().describe("Carton code, or null to clear it."),
            }),
          )
          .max(500)
          .optional()
          .describe("Shipment-line carton assignments."),
        custom: z
          .record(z.string(), z.json())
          .optional()
          .describe("Optional header custom-field values."),
        idempotencyKey: KEY,
      })
      .refine(
        (body) =>
          body.carrier !== undefined || body.cartons !== undefined || body.custom !== undefined,
        { message: "Send at least one shipment field to change." },
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "fulfillment",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      await scopedDocument(context, input.shipmentId, "shipment");
      const orgId = context.authz.user.orgId;
      try {
        await db.transaction(async (tx) => {
          if (input.carrier)
            await setShipmentCarrier(tx, orgId, context.authz.user.id, {
              shipmentId: input.shipmentId,
              ...input.carrier,
              allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
            });
          if (input.cartons)
            await setShipmentCartons(tx, orgId, context.authz.user.id, {
              shipmentId: input.shipmentId,
              cartons: input.cartons,
              allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
            });
          if (input.custom)
            await saveFulfillmentCustom(tx, orgId, context.authz.user.id, {
              documentId: input.shipmentId,
              kind: "shipment",
              custom: input.custom,
            });
        });
        const shipment = await getFulfillmentDocument(
          db,
          orgId,
          input.shipmentId,
          context.authz.allowedSubsidiaryIds,
        );
        if (!shipment) throw notFound("shipment");
        return { ok: true, shipment, href: listRecordDrawerHref("shipment", input.shipmentId) };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "complete_shipment",
    title: "Complete Shipment",
    description:
      "Complete a draft shipment, record the sales fulfillment from its picked bins, and release the reservation. Find the shipment with get_shipment; this action requires inventory posting authority.",
    inputSchema: z.object({ shipmentId: UUID, idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "fulfillment",
    visibleTo: (authz) => can(authz, "orders.fulfill") && can(authz, "items.post"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      assertApplicationPermission(context, "items.post");
      await scopedDocument(context, input.shipmentId, "shipment");
      try {
        const completed = await completeShipment(context.authz.user.orgId, context.authz.user.id, {
          shipmentId: input.shipmentId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...completed, href: listRecordDrawerHref("shipment", input.shipmentId) };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "void_shipment",
    title: "Void Shipment",
    description:
      "Void a draft shipment with a reason after voiding any purchased carrier labels. Find the shipment with get_shipment.",
    inputSchema: z.object({
      shipmentId: UUID,
      reason: z.string().max(1000).describe("Reason for voiding the shipment."),
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
      await scopedDocument(context, input.shipmentId, "shipment");
      try {
        await db.transaction((tx) =>
          voidShipment(tx, context.authz.user.orgId, context.authz.user.id, {
            shipmentId: input.shipmentId,
            reason: input.reason,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          }),
        );
        return {
          ok: true,
          id: input.shipmentId,
          status: "voided",
          href: listRecordDrawerHref("shipment", input.shipmentId),
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "get_shipment_rates",
    title: "Get Shipment Rates",
    description:
      "Request ranked live carrier rates for a draft shipment and handling unit. Find shipment ids with get_shipment and handling-unit ids with list_shipment_handling_units.",
    inputSchema: z.object({
      shipmentId: UUID,
      handlingUnitId: UUID,
      accountId: UUID.nullable()
        .optional()
        .describe("Specific connected carrier account, or omit for the default."),
      presetId: UUID.nullable().optional().describe("Optional shipping preset to apply."),
      direction: z.enum(["outbound", "return"]).optional().describe("Shipment direction."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "never",
    featureKey: "shippingHub",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      await scopedDocument(context, input.shipmentId, "shipment");
      try {
        const quote = await db.transaction((tx) =>
          getShipmentRates(tx, context.authz.user.orgId, context.authz.user.id, {
            ...input,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          }),
        );
        return { ok: true, quote, href: listRecordDrawerHref("shipment", input.shipmentId) };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "validate_shipment_address",
    title: "Validate Shipment Address",
    description:
      "Check a shipment's ship-to address with its carrier and return suggestions without applying them. Find the shipment with get_shipment.",
    inputSchema: z.object({
      shipmentId: UUID,
      accountId: UUID.nullable()
        .optional()
        .describe("Connected carrier account, or omit for the default."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "never",
    featureKey: "shippingHub",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      await scopedDocument(context, input.shipmentId, "shipment");
      try {
        const validation = await db.transaction((tx) =>
          validateShipmentAddress(tx, context.authz.user.orgId, {
            ...input,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          }),
        );
        return { ok: true, validation, href: listRecordDrawerHref("shipment", input.shipmentId) };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "list_shipment_handling_units",
    title: "List Shipment Handling Units",
    description:
      "Read packed cartons, their shipment lines, confirmation quantities, and available warehouse bins. Find the shipment id with get_shipment before rate shopping or buying a label.",
    inputSchema: z.object({ shipmentId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "fulfillment",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      try {
        const units = await getHandlingUnits(
          context.authz.user.orgId,
          context.authz.user.id,
          input.shipmentId,
        );
        const bins = await handlingUnitBinOptions(
          context.authz.user.orgId,
          context.authz.user.id,
          input.shipmentId,
        );
        return {
          ok: true,
          units,
          bins,
          href: listRecordDrawerHref("shipment", input.shipmentId),
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "buy_shipment_label",
    title: "Buy Shipment Label",
    description:
      "Buy the selected carrier rate for a shipment handling unit and record its label cost. Use get_shipment_rates to choose a provider rate; this action spends carrier funds.",
    inputSchema: z.object({
      shipmentId: UUID,
      handlingUnitId: UUID,
      providerRateId: z
        .string()
        .min(1)
        .max(200)
        .describe("Provider rate id returned by get_shipment_rates."),
      accountId: UUID.nullable()
        .optional()
        .describe("Carrier account to charge, or omit for the default."),
      direction: z.enum(["outbound", "return"]).optional().describe("Shipment direction."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    featureKey: "shippingHub",
    visibleTo: visible("shipping.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "shipping.manage");
      await scopedDocument(context, input.shipmentId, "shipment");
      try {
        const label = await db.transaction((tx) =>
          buyShipmentLabel(tx, context.authz.user.orgId, context.authz.user.id, {
            ...input,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          }),
        );
        return {
          ok: true,
          label: { ...label, amountMinor: label.amountMinor.toString() },
          href: listRecordDrawerHref("shipment", input.shipmentId),
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "void_shipment_label",
    title: "Void Shipment Label",
    description:
      "Request a carrier refund for a purchased shipment label and reverse its recorded cost. Find label ids in the shipment's label list; supply a reason.",
    inputSchema: z.object({
      labelId: UUID,
      reason: z.string().min(5).max(500).describe("Reason for voiding the purchased label."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: true,
    assistantConfirmation: "always",
    featureKey: "shippingHub",
    visibleTo: visible("shipping.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "shipping.manage");
      const shipmentId = await shipmentForLabel(context, input.labelId);
      try {
        const voided = await db.transaction((tx) =>
          voidShipmentLabel(tx, context.authz.user.orgId, context.authz.user.id, {
            labelId: input.labelId,
            reason: input.reason,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          }),
        );
        return { ok: true, voided, href: listRecordDrawerHref("shipment", shipmentId) };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "refresh_shipment_tracking",
    title: "Refresh Shipment Tracking",
    description:
      "Re-read a bought label's tracking status from its carrier and store the latest event. Use the shipment label list to find the label id.",
    inputSchema: z.object({ labelId: UUID, idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    featureKey: "shippingHub",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      const shipmentId = await shipmentForLabel(context, input.labelId);
      try {
        const refreshed = await db.transaction((tx) =>
          refreshLabelTracking(tx, context.authz.user.orgId, context.authz.user.id, {
            labelId: input.labelId,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          }),
        );
        if (!refreshed) throw notFound("shipment label");
        return { ok: true, refreshed, href: listRecordDrawerHref("shipment", shipmentId) };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "send_shipment_tracking",
    title: "Email Shipment Tracking",
    description:
      "Email tracking details for a completed shipment to a recipient. Use get_shipment for its id and tracking status; the organization email transport must be configured.",
    inputSchema: z.object({
      shipmentId: UUID,
      to: EMAIL,
      message: z.string().max(2000).optional().describe("Optional note to include in the email."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    featureKey: "fulfillment",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      await scopedDocument(context, input.shipmentId, "shipment");
      try {
        const sent = await sendShipmentTracking(context.authz.user.orgId, context.authz.user.id, {
          ...input,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...sent, href: listRecordDrawerHref("shipment", input.shipmentId) };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "confirm_fulfillment_pick",
    title: "Confirm Fulfillment Pick",
    description:
      "Record a warehouse pick suggestion for a fulfillment task, or confirm an existing task to move picked stock. Find tasks in the warehouse execution queue.",
    inputSchema: fulfillmentPickInputSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "fulfillment",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      const org = context.authz.user.orgId;
      const actor = context.authz.user.id;
      const { idempotencyKey: _key, ...actionInput } = input;
      const action = fulfillmentPickActionSchema.parse(actionInput);
      try {
        if (action.action === "confirm") {
          const outcome = await confirmExecutionTask(org, actor, action, (tx, taskRow) =>
            taskRow.stage === "pick"
              ? executePickDirection(tx, org, actor, taskRow)
              : executePackDirection(tx, org, actor, taskRow),
          );
          const task = await withOrgTransaction(org, () =>
            executionTaskView(db, org, actor, action.taskId),
          );
          return {
            ok: true,
            ...outcome,
            task,
            href: task.stage === "pick" ? "/picks" : "/shipments",
          };
        }
        const suggestion =
          action.action === "pick"
            ? await (() => {
                return suggestPickConfirmation(org, actor, action);
              })()
            : await (() => {
                return suggestPackConfirmation(org, actor, action);
              })();
        const task = await withOrgTransaction(org, () =>
          executionTaskView(db, org, actor, suggestion.id),
        );
        return {
          ok: true,
          task,
          href: action.action === "pick" ? "/picks" : "/shipments",
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "release_pick_wave",
    title: "Release Pick Wave",
    description:
      "Release eligible pick lists for a warehouse and legal entity as a cutoff or priority wave. Use the pick-list reads to choose ids and the warehouse reads for scope.",
    inputSchema: releasePickWaveInput.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "fulfillment",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      try {
        const result = await releasePickWave(
          context.authz.user.orgId,
          context.authz.user.id,
          input,
        );
        return { ok: true, ...result, href: "/picks" };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "set_pick_dispatch_policy",
    title: "Set Pick Dispatch Policy",
    description:
      "Set the priority and cutoff for an individual pick list in the dispatch queue. Find the pick-list id with list_pick_lists.",
    inputSchema: setPickDispatchPolicyInput.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "fulfillment",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      try {
        const result = await setPickDispatchPolicy(
          context.authz.user.orgId,
          context.authz.user.id,
          input,
        );
        return { ok: true, ...result, href: listRecordDrawerHref("pick_list", input.pickListId) };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "manage_shipment_handling_unit",
    title: "Manage Shipment Handling Unit",
    description:
      "Create, seal, or move a carton handling unit for a shipment. Find shipment and line ids with get_shipment and choose a packing bin in the same warehouse.",
    inputSchema: handlingUnitInputSchema,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "fulfillment",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      const { idempotencyKey: _key, ...actionInput } = input;
      const action = handlingUnitActionSchema.parse(actionInput);
      try {
        const orgId = context.authz.user.orgId;
        const actorId = context.authz.user.id;
        const shipmentId =
          action.action === "create"
            ? action.shipmentId
            : await shipmentForHandlingUnit(context, action.unitId);
        const result =
          action.action === "create"
            ? await createHandlingUnit(orgId, actorId, action)
            : action.action === "seal"
              ? await sealHandlingUnit(orgId, actorId, action.unitId)
              : await moveHandlingUnit(orgId, actorId, action);
        return {
          ok: true,
          ...result,
          href: listRecordDrawerHref("shipment", shipmentId),
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
];
