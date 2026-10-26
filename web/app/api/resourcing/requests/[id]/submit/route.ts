import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { submitResourceRequest } from "@openbooks/engine/resourcing/requests";
import { defineRoute } from "@/lib/api/route";

const Params = z.object({ id: uuidString() }).strict();

export const POST = defineRoute({
  permission: "resourcing.manage",
  feature: "resourceRequests",
  params: Params,
  handler: async ({ authz, params }) =>
    Response.json(
      await submitResourceRequest({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        requestId: params.id,
      }),
    ),
});
