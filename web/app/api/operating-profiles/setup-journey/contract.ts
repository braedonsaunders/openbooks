import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { exactMoney } from "@/lib/api/json";

export const SetupJourneyBody = z
  .object({
    family: z.enum(["project", "production"]),
    selection: z.string().min(1).max(100),
    departmentId: uuidString().optional(),
    itemId: uuidString().optional(),
    subsidiaryId: uuidString().optional(),
    quantity: exactMoney().optional(),
  })
  .strict();
