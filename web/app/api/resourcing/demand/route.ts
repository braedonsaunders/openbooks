import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resDemandLines } from "@openbooks/schema";
import { createDemandLine } from "@openbooks/engine/src/resourcing/demand-lines.ts";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { created } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";
import { idempotentResourcingCreate } from "../_idempotent";
import { validateDemandCustomValues } from "./_custom";

const Body = z.object({
  departmentId: z.string().uuid(),
  jobTitle: z.string(),
  firstWeek: z.string(),
  lastWeek: z.string(),
  hoursPerWeek: z.string(),
  note: z.string().nullable().optional(),
  opportunityId: z.string().uuid().nullable().optional(),
  custom: z.record(z.string(), z.json()).optional(),
}).strict();
const Params = z.object({}).strict();

export const POST = defineRoute({
  permission: "resourcing.manage",
  feature: "resourcing",
  params: Params,
  body: Body,
  handler: async ({ request, authz, body }) => {
    const custom = await validateDemandCustomValues(authz.user.orgId, body.custom);
    if (custom instanceof Response) return custom;
    return withOrgTransaction(authz.user.orgId, async () => {
      const match = { ...body, custom: custom.cleaned };
      const row = await idempotentResourcingCreate({
        orgId: authz.user.orgId,
        request,
        table: "res_demand_lines",
        match,
        create: (id, requestId, savedMatch) => createDemandLine({
          ...body,
          custom: custom.cleaned,
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        }, { id, requestId, match: savedMatch }),
        load: async () => (await db.select().from(resDemandLines).where(and(
          eq(resDemandLines.orgId, authz.user.orgId),
          eq(resDemandLines.id, request.headers.get("Idempotency-Key")!.trim()),
        )).limit(1))[0] ?? null,
      });
      return created(row);
    });
  },
});
