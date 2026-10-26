import { lockManufacturingCenterAuthority } from "@openbooks/engine/manufacturing/authority";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import {
  createWorkCenter,
  getWorkCenter,
  type WorkCenterInput,
} from "@openbooks/engine/manufacturing/work-centers";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { created } from "@/lib/api/responses";
import { idempotentManufacturingCreate } from "../_idempotent";
import { manufacturingTransaction } from "../_transaction";

const Body = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  subsidiaryId: uuidString().nullable().optional(),
  kind: z.enum(["machine", "labor", "cell"]),
  capacityHoursPerDay: z.string(),
  efficiencyPct: z.string(),
  departmentId: uuidString().nullable().optional(),
  absorbsOverhead: z.boolean(),
  calendarId: uuidString().nullable().optional(),
});
const Params = z.object({}).strict();

export const POST = defineRoute({
  permission: "manufacturing.manage",
  feature: "manufacturing",
  params: Params,
  body: Body,
  handler: async ({ request, authz, body }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const input = body as WorkCenterInput;
      const denied = guardSubsidiaryScope(authz, input.subsidiaryId ?? null);
      if (denied) return denied;
      const match = { ...input };
      const row = await idempotentManufacturingCreate({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        request,
        table: "mfg_work_centers",
        match,
        create: (id, requestId, savedMatch) =>
          createWorkCenter(db, authz.user.orgId, authz.user.id, input, {
            id,
            requestId,
            match: savedMatch,
          }),
        load: async () => {
          const id = request.headers.get("Idempotency-Key")!.trim();
          await lockManufacturingCenterAuthority(db, authz.user.orgId, authz.user.id, id);
          return getWorkCenter(db, authz.user.orgId, id);
        },
      });
      return created(row);
    }),
});
