import { z } from "zod";
import { upsertAssignment } from "@openbooks/engine/src/resourcing/assignments.ts";
import { defineRoute } from "@/lib/api/route";

const Common = {
  projectId: z.string().uuid(),
  weekStart: z.string(),
  plannedHours: z.string(),
  isBillable: z.boolean().optional(),
  billItemId: z.string().uuid().nullable().optional(),
  projectTaskId: z.string().uuid().nullable().optional(),
  booking: z.enum(["soft", "hard"]).optional(),
  source: z.enum(["manual", "request", "pipeline"]).optional(),
  requestId: z.string().uuid().nullable().optional(),
};
const Body = z.union([
  z.object({ ...Common, employeePartyId: z.string().uuid() }).strict(),
  z.object({ ...Common, jobTitle: z.string().trim().min(1) }).strict(),
]);

export const POST = defineRoute({
  permission: "resourcing.manage",
  feature: "resourcing",
  body: Body,
  handler: async ({ authz, body }) => {
    const result = await upsertAssignment({
      ...body,
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    });
    return Response.json(result);
  },
});
