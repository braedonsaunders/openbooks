import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
export const resourceRecipientBody = z.strictObject({
  boardId: uuidString(),
  equipmentUnitId: uuidString().nullable(),
  resourceLocationId: uuidString().nullable(),
  partyId: uuidString(),
  reason: z.string().trim().min(1).max(2000),
  isActive: z.boolean(),
});
