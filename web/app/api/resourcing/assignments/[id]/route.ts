import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { deleteAssignment } from "@openbooks/engine/resourcing/assignments";
import { defineRoute } from "@/lib/api/route";

const Params = z.object({ id: uuidString() }).strict();

export const DELETE = defineRoute({
  permission: "resourcing.manage",
  feature: "resourcing",
  params: Params,
  handler: async ({ authz, params }) => {
    await deleteAssignment({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      assignmentId: params.id,
    });
    return Response.json({ deleted: true });
  },
});
