import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { cancelResourceRequest } from "@openbooks/engine/resourcing/requests";
import { defineRoute } from "@/lib/api/route";

const Params = z.object({ id: uuidString() }).strict();
const Body = z.object({ reason: z.string() }).strict();

export const POST = defineRoute({
  permission: "resourcing.manage",
  feature: "resourceRequests",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) =>
    Response.json(
      await cancelResourceRequest({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        requestId: params.id,
        reason: body.reason,
      }),
    ),
});
