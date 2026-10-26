import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";

export const deviceBody = z.strictObject({
  subsidiaryId: uuidString(),
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(160),
  timeZone: z.string().min(1).max(128),
  isActive: z.boolean(),
  reason: z.string().trim().min(1).max(2000),
});
