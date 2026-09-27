import { z } from "zod";
import { cancelResourceRequest } from "@openbooks/engine/src/resourcing/requests.ts";
import { defineRoute } from "@/lib/api/route";

const Params = z.object({ id: z.string().uuid() }).strict();
const Body = z.object({ reason: z.string() }).strict();

export const POST = defineRoute({
  permission: "resourcing.manage",
  feature: "resourceRequests",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) => Response.json(await cancelResourceRequest({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    requestId: params.id,
    reason: body.reason,
  })),
});
