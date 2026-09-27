import { z } from "zod";
import { updateResourceRequestDraft } from "@openbooks/engine/src/resourcing/requests.ts";
import { defineRoute } from "@/lib/api/route";

const Params = z.object({ id: z.string().uuid() }).strict();
const Common = {
  projectId: z.string().uuid(),
  firstWeek: z.string(),
  lastWeek: z.string(),
  hoursPerWeek: z.string(),
  isBillable: z.boolean().optional(),
  billItemId: z.string().uuid().nullable().optional(),
  reason: z.string().nullable().optional(),
};
const Body = z.union([
  z.object({ ...Common, employeePartyId: z.string().uuid() }).strict(),
  z.object({ ...Common, jobTitle: z.string().trim().min(1) }).strict(),
]);

export const PATCH = defineRoute({
  permission: "resourcing.manage",
  feature: "resourceRequests",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) => Response.json(await updateResourceRequestDraft({
    ...body,
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    requestId: params.id,
  })),
});
