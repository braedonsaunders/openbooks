import { z } from "zod";
import { closeRetainer } from "@openbooks/engine/src/resourcing/retainers.ts";
import { defineRoute } from "@/lib/api/route";

const Params = z.object({ id: z.string().uuid() }).strict();

export const POST = defineRoute({
  permission: "retainers.manage",
  feature: "retainerBilling",
  params: Params,
  handler: async ({ authz, params }) => {
    await closeRetainer({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      retainerId: params.id,
    });
    return Response.json({ closed: true });
  },
});
