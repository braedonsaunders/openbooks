import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const identityBody = z.strictObject({
  deviceId: uuidString(),
  sourceWorkerId: z.string().trim().min(1).max(160),
  workerPartyId: uuidString(),
  employmentId: uuidString().nullable().optional(),
  effectiveFrom: date,
  effectiveTo: date.nullable(),
  reason: z.string().trim().min(1).max(2000),
});
