import { z } from "zod";
import { postDrawdown } from "@openbooks/engine/src/resourcing/retainer-billing.ts";
import { defineRoute } from "@/lib/api/route";

const Params = z.object({ id: z.string().uuid(), drawdownId: z.string().uuid() });

export const POST = defineRoute({
  permission: "retainers.manage",
  feature: "retainerBilling",
  params: Params,
  handler: async ({ authz, params }) => {
    const result = await postDrawdown({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      retainerId: params.id,
      drawdownId: params.drawdownId,
    });
    return Response.json(result);
  },
});
