import { z } from "zod";
import { releaseAssignment } from "@openbooks/engine/src/resourcing/assignments.ts";
import { defineRoute } from "@/lib/api/route";

const Params = z.object({ id: z.string().uuid() }).strict();

export const POST = defineRoute({
  permission: "resourcing.manage",
  feature: "resourcing",
  params: Params,
  handler: async ({ authz, params }) => Response.json(await releaseAssignment({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    assignmentId: params.id,
  })),
});
