import "server-only";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  activateWarehouse,
  getWarehouse,
  retireWarehouse,
  suspendWarehouse,
} from "@openbooks/engine/inventory/warehouses";
import { executeIdempotentInventoryAction } from "@openbooks/engine/inventory/action-idempotency";
import { putAwayStagedStock } from "@openbooks/engine/inventory/putaway";
import { can, guardSubsidiaryScope } from "../authz";
import { type ApplicationToolDefinition } from "./tool-definition";
import {
  inventoryDefinition as definition,
  DATE,
  IDEMPOTENCY_KEY,
  settleInventoryRefusal,
  UUID,
} from "./inventory-tools-common";
import { assertApplicationPermission } from "./context";
import { forbidden, notFound } from "./errors";
import { z } from "zod";

const visibleTo = (authz: Parameters<ApplicationToolDefinition["visibleTo"]>[0]) =>
  can(authz, "items.warehouses");
function assertUnrestricted(context: Parameters<ApplicationToolDefinition["execute"]>[0]): void {
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

export const INVENTORY_WAREHOUSE_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "activate_warehouse",
    title: "Activate Warehouse",
    description:
      "Activate a draft or suspended warehouse so it can accept stock. Find the warehouse id with list_warehouses and verify its status with get_warehouse.",
    inputSchema: z.object({
      warehouseId: UUID.describe("Warehouse id from list_warehouses."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo,
    featureKey: "warehousing",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.warehouses");
      assertUnrestricted(context);
      try {
        const warehouse = await activateWarehouse(context.authz.user.orgId, context.authz.user.id, {
          warehouseId: input.warehouseId,
        });
        return {
          ok: true,
          warehouse,
          href: `/warehouse?warehouse=${encodeURIComponent(input.warehouseId)}`,
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "suspend_warehouse",
    title: "Suspend Warehouse",
    description:
      "Suspend an active warehouse so it refuses inbound stock while allowing drawdown. Find the warehouse id with list_warehouses; get_warehouse shows its saved status.",
    inputSchema: z.object({
      warehouseId: UUID.describe("Warehouse id from list_warehouses."),
      reason: z.string().min(3).max(500).describe("Reason for suspending the warehouse."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo,
    featureKey: "warehousing",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.warehouses");
      assertUnrestricted(context);
      try {
        const warehouse = await suspendWarehouse(context.authz.user.orgId, context.authz.user.id, {
          warehouseId: input.warehouseId,
          reason: input.reason,
        });
        return {
          ok: true,
          warehouse,
          href: `/warehouse?warehouse=${encodeURIComponent(input.warehouseId)}`,
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "retire_warehouse",
    title: "Retire Warehouse",
    description:
      "Retire an active or suspended warehouse after it is empty; retired warehouses keep their history and cannot reopen. Find the warehouse id with list_warehouses and verify with get_warehouse.",
    inputSchema: z.object({
      warehouseId: UUID.describe("Warehouse id from list_warehouses."),
      reason: z.string().min(3).max(500).describe("Reason for retiring the warehouse."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo,
    featureKey: "warehousing",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.warehouses");
      assertUnrestricted(context);
      try {
        const warehouse = await retireWarehouse(context.authz.user.orgId, context.authz.user.id, {
          warehouseId: input.warehouseId,
          reason: input.reason,
        });
        return {
          ok: true,
          warehouse,
          href: `/warehouse?warehouse=${encodeURIComponent(input.warehouseId)}`,
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "putaway_warehouse_stock",
    title: "Put Away Warehouse Stock",
    description:
      "Move staged stock into the warehouse location selected by its putaway rules. Find the warehouse with list_warehouses and use a subsidiary visible to the caller; verify the resulting on-hand position with inventory reads.",
    inputSchema: z.object({
      warehouseId: UUID.describe("Warehouse id from list_warehouses."),
      stagingLocationId: UUID.describe(
        "Staging stock location id from the warehouse or inventory read.",
      ),
      itemId: UUID.describe("Item id from search_items or get_item."),
      subsidiaryId: UUID.describe("Legal entity that owns this stock."),
      quantity: z
        .string()
        .regex(/^\d+(?:\.\d{1,8})?$/)
        .describe("Positive exact decimal quantity string."),
      date: DATE.optional().describe(
        "Business date; omitted uses the organization's current business date.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "items.post"),
    featureKey: "warehousing",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      const denied = guardSubsidiaryScope(context.authz, input.subsidiaryId);
      if (denied) throw notFound("record");
      const orgId = context.authz.user.orgId;
      if (!(await getWarehouse(db, orgId, input.warehouseId))) throw notFound("warehouse");
      const date = input.date ?? (await businessToday(orgId));
      const request = {
        warehouseId: input.warehouseId,
        stagingLocationId: input.stagingLocationId,
        itemId: input.itemId,
        subsidiaryId: input.subsidiaryId,
        quantity: input.quantity,
        date,
      };
      try {
        const outcome = await executeIdempotentInventoryAction(orgId, context.authz.user.id, {
          operation: "warehouse.putaway",
          idempotencyKey: input.idempotencyKey,
          request,
          execute: () =>
            db.transaction((tx) => putAwayStagedStock(tx, orgId, context.authz.user.id, request)),
        });
        return {
          ok: true,
          ...outcome.value,
          replayed: outcome.replayed,
          href: `/warehouse?warehouse=${encodeURIComponent(input.warehouseId)}`,
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
];
