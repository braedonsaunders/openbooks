import { z } from "zod";
import { uuidId } from "./json";
import { canonicalDecimal } from "../exact-decimal";
export const executionQuantity = z
  .string()
  .refine(
    (value) => canonicalDecimal(value, 8) !== null,
    "Quantity must be decimal text with at most eight decimal places",
  )
  .transform((value) => canonicalDecimal(value, 8)!)
  .describe("Exact decimal quantity, with at most eight fractional digits.");
export const executionScan = z.object({
  item: z.string().min(1).max(200).describe("Scanned item identifier or barcode."),
  bin: z.string().min(1).max(200).describe("Scanned bin identifier or barcode."),
  quantity: executionQuantity,
  lot: z.string().min(1).max(200).optional().describe("Scanned lot identifier when required."),
  serial: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Scanned serial identifier when required."),
});
export const confirmExecutionBody = z.object({
  action: z.literal("confirm").describe("Confirm an existing warehouse execution task."),
  taskId: uuidId.describe("Warehouse execution task UUID."),
  scan: executionScan.optional().describe("Optional scan evidence to verify the task."),
});
export const executionKey = z
  .string()
  .min(8)
  .max(200)
  .describe("Stable warehouse command key for replay-safe pick or pack suggestions.");
export const executionActionBody = z.discriminatedUnion("action", [
  confirmExecutionBody,
  z.object({
    action: z.literal("pick").describe("Create a pick suggestion from a warehouse task."),
    lineId: uuidId.describe("Execution line UUID."),
    quantity: executionQuantity,
    reason: z.string().max(500).optional().describe("Reason for a short pick."),
    commandKey: executionKey,
  }),
  z.object({
    action: z.literal("pack").describe("Create a pack suggestion for a handling unit."),
    unitId: uuidId.describe("Handling unit UUID."),
    lineId: uuidId.describe("Execution line UUID."),
    commandKey: executionKey,
  }),
]);

import { InventoryError } from "@openbooks/engine/inventory/contracts/module";
import { apiErrorResponse } from "./error-response";
import { inventoryErrorStatus } from "./inventory-errors";
import { PackingRefusal } from "@openbooks/engine/sales/handling-unit-state";
export async function warehouseExecutionResponse(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof InventoryError)
      return apiErrorResponse(error, {
        safeStatus: error instanceof PackingRefusal ? error.status : inventoryErrorStatus(error),
      });
    throw error;
  }
}
