import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { endWorkCenterRate, getWorkCenter } from "@openbooks/engine/src/manufacturing/work-centers.ts";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { manufacturingTransaction } from "../../../../_transaction";

const Params = z.object({ id: z.string().uuid(), rateId: z.string().uuid() });
const Body = z.object({ effectiveTo: z.string() });

export const PATCH = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturing", params: Params, body: Body,
  handler: async ({ authz, params, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    const center = await getWorkCenter(db, authz.user.orgId, params.id);
    if (!center) return notFound("work center");
    const denied = guardSubsidiaryScope(authz, center.subsidiaryId as string | null);
    if (denied) return denied;
    return Response.json(await endWorkCenterRate(db, authz.user.orgId, authz.user.id, params.id, params.rateId, body.effectiveTo));
  }),
});
