import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { postDrawdown } from "@openbooks/engine/resourcing/retainer-billing";
import { defineRoute } from "@/lib/api/route";

const Params = z.object({ id: uuidString(), drawdownId: uuidString() });

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
