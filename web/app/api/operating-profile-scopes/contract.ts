import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
export const ScopeBody = z
  .object({
    departmentId: uuidString().nullable(),
    family: z.enum(["project", "production"]),
    profileIds: z.array(uuidString()).min(1).max(100),
    defaultProfileId: uuidString().nullable(),
    reason: z.string(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict();
