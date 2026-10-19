import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { closeRetainer } from "@openbooks/engine/resourcing/retainers";
import { defineRoute } from "@/lib/api/route";

const Params = z.object({ id: uuidString() }).strict();

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
