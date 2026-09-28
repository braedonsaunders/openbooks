import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { departments, resDemandLines } from "@openbooks/schema";
import { deleteDemandLine, updateDemandLine } from "@openbooks/engine/src/resourcing/demand-lines.ts";
import { ScopeNotFoundError } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { defineRoute } from "@/lib/api/route";
import { validateDemandCustomValues } from "../_custom";

const Params = z.object({ id: z.string().uuid() }).strict();
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

export const PATCH = defineRoute({
  permission: "resourcing.manage",
  feature: "resourcing",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) => {
    const existing = (await db.select({ custom: resDemandLines.custom })
      .from(resDemandLines)
      .innerJoin(departments, and(
        eq(departments.orgId, resDemandLines.orgId),
        eq(departments.id, resDemandLines.departmentId),
      ))
      .where(and(
        eq(resDemandLines.orgId, authz.user.orgId),
        eq(resDemandLines.id, params.id),
        authz.allowedSubsidiaryIds === null
          ? undefined
          : inArray(departments.subsidiaryId, [...authz.allowedSubsidiaryIds]),
      ))
      .limit(1))[0];
    if (!existing) throw new ScopeNotFoundError();
    const custom = await validateDemandCustomValues(
      authz.user.orgId,
      body.custom,
      (existing.custom ?? {}) as Record<string, unknown>,
    );
    if (custom instanceof Response) return custom;
    return Response.json(await updateDemandLine({
      ...body,
      custom: custom.cleaned,
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      demandLineId: params.id,
    }));
  },
});

export const DELETE = defineRoute({
  permission: "resourcing.manage",
  feature: "resourcing",
  params: Params,
  handler: async ({ authz, params }) => {
    await deleteDemandLine({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      demandLineId: params.id,
    });
    return Response.json({ deleted: true });
  },
});
