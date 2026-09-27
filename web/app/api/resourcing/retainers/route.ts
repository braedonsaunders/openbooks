import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resRetainers } from "@openbooks/schema";
import { createRetainer } from "@openbooks/engine/src/resourcing/retainers.ts";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { created } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";
import { idempotentResourcingCreate } from "../_idempotent";

const Body = z.object({
  projectId: z.string().uuid(),
  customerPartyId: z.string().uuid(),
  kind: z.enum(["hours", "fees"]),
  totalAmount: z.string().optional(),
  totalHours: z.string().optional(),
  unitRate: z.string().optional(),
  startsOn: z.string(),
  endsOn: z.string(),
  retainerItemId: z.string().uuid(),
  custom: z.record(z.string(), z.unknown()).optional(),
}).strict();
const Params = z.object({}).strict();

export const POST = defineRoute({
  permission: "retainers.manage",
  feature: "retainerBilling",
  params: Params,
  body: Body,
  handler: async ({ request, authz, body }) => withOrgTransaction(authz.user.orgId, async () => {
    const match = { ...body };
    const row = await idempotentResourcingCreate({
      orgId: authz.user.orgId,
      request,
      table: "res_retainers",
      match,
      create: (id, requestId, savedMatch) => createRetainer({
        ...body,
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      }, { id, requestId, match: savedMatch }),
      load: async () => (await db.select().from(resRetainers).where(and(
        eq(resRetainers.orgId, authz.user.orgId),
        eq(resRetainers.id, request.headers.get("Idempotency-Key")!.trim()),
      )).limit(1))[0] ?? null,
    });
    return created(row);
  }),
});
