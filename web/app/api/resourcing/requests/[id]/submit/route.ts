import { z } from "zod";
import { submitResourceRequest } from "@openbooks/engine/src/resourcing/requests.ts";
import { defineRoute } from "@/lib/api/route";

const Params = z.object({ id: z.string().uuid() }).strict();

export const POST = defineRoute({
  permission: "resourcing.manage",
  feature: "resourceRequests",
  params: Params,
  handler: async ({ authz, params }) => Response.json(await submitResourceRequest({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    requestId: params.id,
  })),
});
