import "server-only";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  confirmExecutionTask,
  executionTaskView,
} from "@openbooks/engine/inventory/directed-execution";
import {
  suggestReceiptConfirmation,
  suggestPutaway,
  suggestCountObservation,
  executeInventoryDirection,
} from "@openbooks/engine/inventory/warehouse-directions";
import { can } from "../authz";
import { type ApplicationToolDefinition } from "./tool-definition";
import {
  inventoryDefinition as definition,
  DATE,
  IDEMPOTENCY_KEY,
  settleInventoryRefusal,
  UUID,
} from "./inventory-tools-common";
import { assertApplicationPermission } from "./context";
import { z } from "zod";

const visiblePost = (authz: Parameters<ApplicationToolDefinition["visibleTo"]>[0]) =>
  can(authz, "items.post");
const executionHref = (taskId?: string) =>
  taskId ? `/warehouse?task=${encodeURIComponent(taskId)}` : "/warehouse";
const SCAN = z
  .object({
    item: z.string().min(1).max(200).describe("Scanned item code or barcode."),
    bin: z.string().min(1).max(200).describe("Scanned destination bin code."),
    quantity: z
      .string()
      .regex(/^\d+(?:\.\d{1,8})?$/)
      .describe("Scanned exact quantity."),
    lot: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Scanned lot number when tracking requires one."),
    serial: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Scanned serial number when tracking requires one."),
  })
  .describe("Observed item, bin, quantity and tracking identifiers.");

async function readTask(
  context: Parameters<ApplicationToolDefinition["execute"]>[0],
  taskId: string,
) {
  return withOrgTransaction(context.authz.user.orgId, async () =>
    executionTaskView(db, context.authz.user.orgId, context.authz.user.id, taskId),
  );
}

export const INVENTORY_EXECUTION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_warehouse_execution_task",
    title: "Get Warehouse Execution Task",
    description:
      "Read a directed warehouse task and its expected item, bin and quantity before scanning or confirming it. Find the task id in the result of a warehouse task suggestion command.",
    inputSchema: z.object({
      taskId: UUID.describe("Task id returned by a warehouse suggestion command."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visiblePost,
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      try {
        return { task: await readTask(context, input.taskId), href: executionHref(input.taskId) };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "suggest_receipt_execution",
    title: "Suggest Receipt Execution",
    description:
      "Create a scan-confirmation task for stock already posted from an approved purchase receipt. Find the receipt line id through the receipt read and verify the task with get_warehouse_execution_task.",
    inputSchema: z.object({
      receiptLineId: UUID.describe("Approved purchase receipt line id with posted stock."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visiblePost,
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      try {
        const task = await suggestReceiptConfirmation(
          context.authz.user.orgId,
          context.authz.user.id,
          { lineId: input.receiptLineId, commandKey: input.idempotencyKey },
        );
        return { ok: true, task: await readTask(context, task.id), href: executionHref(task.id) };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "suggest_warehouse_putaway",
    title: "Suggest Warehouse Putaway",
    description:
      "Create a directed putaway task for available staged stock using the warehouse's saved putaway rules. Find item, warehouse, staging bin and subsidiary ids from inventory reads; verify the task with get_warehouse_execution_task.",
    inputSchema: z.object({
      warehouseId: UUID.describe("Warehouse id from list_warehouses."),
      stagingLocationId: UUID.describe("Active staging bin in this warehouse."),
      itemId: UUID.describe("Item id from search_items or get_item."),
      subsidiaryId: UUID.describe("Legal entity that owns the staged stock."),
      quantity: z
        .string()
        .regex(/^\d+(?:\.\d{1,8})?$/)
        .describe("Exact positive staged quantity."),
      date: DATE.describe("Business date for the directed movement."),
      lotId: UUID.nullable().optional().describe("Lot id when the stock is lot-tracked."),
      serialId: UUID.nullable().optional().describe("Serial id when the stock is serial-tracked."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visiblePost,
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      try {
        const task = await suggestPutaway(context.authz.user.orgId, context.authz.user.id, {
          warehouseId: input.warehouseId,
          stagingLocationId: input.stagingLocationId,
          itemId: input.itemId,
          subsidiaryId: input.subsidiaryId,
          quantity: input.quantity,
          date: input.date,
          lotId: input.lotId ?? null,
          serialId: input.serialId ?? null,
          commandKey: input.idempotencyKey,
        });
        return { ok: true, task: await readTask(context, task.id), href: executionHref(task.id) };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "suggest_count_execution",
    title: "Suggest Count Execution",
    description:
      "Create a scan-confirmation task for a first or second observation on a cycle-count line. Find the line id with get_stock_count and verify the task with get_warehouse_execution_task.",
    inputSchema: z.object({
      lineId: UUID.describe("Line id from get_stock_count."),
      quantity: z
        .string()
        .regex(/^\d+(?:\.\d{1,8})?$/)
        .describe("Exact non-negative observed quantity."),
      observation: z
        .enum(["first", "second"])
        .describe("Whether this is the first or independent second observation."),
      reason: z.string().max(500).optional().describe("Reason for the observation."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visiblePost,
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      try {
        const task = await suggestCountObservation(
          context.authz.user.orgId,
          context.authz.user.id,
          {
            lineId: input.lineId,
            quantity: input.quantity,
            observation: input.observation,
            reason: input.reason,
            commandKey: input.idempotencyKey,
          },
        );
        return { ok: true, task: await readTask(context, task.id), href: executionHref(task.id) };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "confirm_warehouse_execution_task",
    title: "Confirm Warehouse Execution Task",
    description:
      "Confirm an open receipt, putaway or count task by scanning the suggested item, bin and exact quantity when Barcode scanning is enabled. Find the task id with a suggestion command and read the current state with get_warehouse_execution_task.",
    inputSchema: z.object({
      taskId: UUID.describe("Open task id from get_warehouse_execution_task."),
      scan: SCAN.optional().describe(
        "Observed scan; when barcode scanning is off the native task may be confirmed manually.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visiblePost,
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      try {
        const result = await confirmExecutionTask(
          context.authz.user.orgId,
          context.authz.user.id,
          { taskId: input.taskId, scan: input.scan },
          (tx, task) =>
            executeInventoryDirection(tx, context.authz.user.orgId, context.authz.user.id, task),
        );
        return {
          ok: true,
          ...result,
          task: await readTask(context, input.taskId),
          href: executionHref(input.taskId),
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
];
