import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { createWorkCenter, getWorkCenter, type WorkCenterInput } from "@openbooks/engine/src/manufacturing/work-centers.ts";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { created } from "@/lib/api/responses";
import { idempotentManufacturingCreate } from "../_idempotent";
import { manufacturingTransaction } from "../_transaction";

const Body = z.object({
  code: z.string().trim().min(1), name: z.string().trim().min(1),
  subsidiaryId: z.string().uuid().nullable().optional(), kind: z.enum(["machine", "labor", "cell"]),
  capacityHoursPerDay: z.string(), efficiencyPct: z.string(), departmentId: z.string().uuid().nullable().optional(),
  absorbsOverhead: z.boolean(), calendarId: z.string().uuid().nullable().optional(),
});
const Params = z.object({}).strict();

export const POST = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturing", params: Params, body: Body,
  handler: async ({ request, authz, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    const input = body as WorkCenterInput;
    const denied = guardSubsidiaryScope(authz, input.subsidiaryId ?? null);
    if (denied) return denied;
    const match = { ...input };
    const row = await idempotentManufacturingCreate({
      orgId: authz.user.orgId, request, table: "mfg_work_centers", match,
      create: (id, requestId, savedMatch) => createWorkCenter(db, authz.user.orgId, authz.user.id, input, { id, requestId, match: savedMatch }),
      load: () => getWorkCenter(db, authz.user.orgId, request.headers.get("Idempotency-Key")!.trim()),
    });
    return created(row);
  }),
});
