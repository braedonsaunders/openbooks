import { lockManufacturingCenterAuthority } from "@openbooks/engine/src/manufacturing/authority.ts";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { addWorkCenterRate, getWorkCenter, getWorkCenterRate } from "@openbooks/engine/src/manufacturing/work-centers.ts";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { created, notFound } from "@/lib/api/responses";
import { idempotentManufacturingCreate } from "../../../_idempotent";
import { manufacturingTransaction } from "../../../_transaction";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({ machineRatePerHour: z.string(), effectiveFrom: z.string(), effectiveTo: z.string().nullable().optional() });

export const POST = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturing", params: Params, body: Body,
  handler: async ({ request, authz, params, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    const center = await getWorkCenter(db, authz.user.orgId, params.id);
    if (!center) return notFound("work center");
    const denied = guardSubsidiaryScope(authz, center.subsidiaryId as string | null);
    if (denied) return denied;
    const match = { workCenterId: params.id, ...body };
    const row = await idempotentManufacturingCreate({
      orgId: authz.user.orgId, actorId: authz.user.id, request, table: "mfg_work_center_rates", match,
      create: (id, requestId, savedMatch) => addWorkCenterRate(db, authz.user.orgId, authz.user.id, params.id, body, { id, requestId, match: savedMatch }),
      load: async () => { await lockManufacturingCenterAuthority(db,authz.user.orgId,authz.user.id,params.id); return getWorkCenterRate(db,authz.user.orgId,params.id,request.headers.get("Idempotency-Key")!.trim()); },
    });
    return created(row);
  }),
});
