import { z } from "zod";
import { extendRetainer } from "@openbooks/engine/src/resourcing/retainers.ts";
import { defineRoute } from "@/lib/api/route";

const Params = z.object({ id: z.string().uuid() }).strict();
const Body = z.object({ newEndsOn: z.string() }).strict();

export const POST = defineRoute({
  permission: "retainers.manage",
  feature: "retainerBilling",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) => Response.json(await extendRetainer({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    retainerId: params.id,
    newEndsOn: body.newEndsOn,
  })),
});
