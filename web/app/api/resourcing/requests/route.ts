import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resRequests } from "@openbooks/schema";
import { createResourceRequest } from "@openbooks/engine/src/resourcing/requests.ts";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { created } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";
import { idempotentResourcingCreate } from "../_idempotent";

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
const Params = z.object({}).strict();

export const POST = defineRoute({
  permission: "resourcing.manage",
  feature: "resourceRequests",
  params: Params,
  body: Body,
  handler: async ({ request, authz, body }) => withOrgTransaction(authz.user.orgId, async () => {
    const match = { ...body };
    const row = await idempotentResourcingCreate({
      orgId: authz.user.orgId,
      request,
      table: "res_requests",
      match,
      create: (id, requestId, savedMatch) => createResourceRequest({
        ...body,
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      }, { id, requestId, match: savedMatch }),
      load: async () => (await db.select().from(resRequests).where(and(
        eq(resRequests.orgId, authz.user.orgId),
        eq(resRequests.id, request.headers.get("Idempotency-Key")!.trim()),
      )).limit(1))[0] ?? null,
    });
    return created(row);
  }),
});
