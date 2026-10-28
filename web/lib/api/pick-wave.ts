import { z } from "zod";
import { uuidId } from "./json";
import { executionKey } from "./warehouse-execution";

const cutoffAt = z
  .string()
  .max(40)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine((value) => z.iso.datetime({ offset: true }).safeParse(value).success)
  .describe("Cutoff timestamp including its UTC offset.");

export const releasePickWaveInput = z.object({
  warehouseId: uuidId.describe("Warehouse UUID for the dispatch wave."),
  subsidiaryId: uuidId.describe("Legal entity UUID that owns the warehouse."),
  mode: z.enum(["cutoff", "priority"]).describe("Wave release policy."),
  cutoffAt,
  pickListIds: z
    .array(uuidId.describe("Pick-list UUID to include in the wave."))
    .min(1)
    .max(500)
    .optional()
    .describe("Specific pick lists; omit to use eligible lists."),
  commandKey: executionKey,
});

export const setPickDispatchPolicyInput = z.object({
  pickListId: uuidId.describe("Pick-list UUID to prioritize."),
  priority: z
    .number()
    .int()
    .min(-2147483648)
    .max(2147483647)
    .describe("Dispatch priority; larger values take precedence."),
  cutoffAt,
});

export const pickWaveBody = z.discriminatedUnion("action", [
  releasePickWaveInput.extend({ action: z.literal("release") }),
  setPickDispatchPolicyInput.extend({ action: z.literal("policy") }),
]);
