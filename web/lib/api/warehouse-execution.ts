import { z } from "zod";
import { uuidId } from "./json";
import { canonicalDecimal } from "../exact-decimal";
export const executionQuantity = z
  .string()
  .refine(
    (value) => canonicalDecimal(value, 8) !== null,
    "Quantity must be decimal text with at most eight decimal places",
  )
  .transform((value) => canonicalDecimal(value, 8)!);
export const executionScan = z.object({
  item: z.string().min(1).max(200),
  bin: z.string().min(1).max(200),
  quantity: executionQuantity,
  lot: z.string().min(1).max(200).optional(),
  serial: z.string().min(1).max(200).optional(),
});
export const confirmExecutionBody = z.object({
  action: z.literal("confirm"),
  taskId: uuidId,
  scan: executionScan.optional(),
});
export const executionKey = z.string().min(8).max(200);

import { InventoryError } from "@openbooks/engine/src/inventory/contracts.ts";
import { apiErrorResponse } from "./error-response";
import { inventoryErrorStatus } from "./inventory-errors";
import { PackingRefusal } from "@openbooks/engine/src/sales/handling-unit-state.ts";
export async function warehouseExecutionResponse(
  work: () => Promise<Response>,
): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof InventoryError)
      return apiErrorResponse(error, {
        safeStatus:
          error instanceof PackingRefusal
            ? error.status
            : inventoryErrorStatus(error),
      });
    throw error;
  }
}
