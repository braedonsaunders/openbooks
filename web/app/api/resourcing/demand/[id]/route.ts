import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { departments, resDemandLines } from "@openbooks/schema";
import { deleteDemandLine, updateDemandLine } from "@openbooks/engine/resourcing/demand-lines";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { db } from "@openbooks/engine/platform/db";
import { defineRoute } from "@/lib/api/route";
import { validateDemandCustomValues } from "../_custom";

const Params = z.object({ id: uuidString() }).strict();
const Body = z
  .object({
    departmentId: uuidString(),
    jobTitle: z.string(),
    firstWeek: z.string(),
    lastWeek: z.string(),
    hoursPerWeek: z.string(),
    note: z.string().nullable().optional(),
    opportunityId: uuidString().nullable().optional(),
    custom: z.record(z.string(), z.json()).optional(),
  })
  .strict();

export const PATCH = defineRoute({
  permission: "resourcing.manage",
  feature: "resourcing",
  params: Params,
  body: Body,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) => {
    if (authz.allowedSubsidiaryIds?.size === 0) throw new ScopeNotFoundError();
    const existing = (
      await db
        .select({ custom: resDemandLines.custom })
        .from(resDemandLines)
        .innerJoin(
          departments,
          and(
            eq(departments.orgId, resDemandLines.orgId),
            eq(departments.id, resDemandLines.departmentId),
          ),
        )
        .where(
          and(
            eq(resDemandLines.orgId, authz.user.orgId),
            eq(resDemandLines.id, params.id),
            authz.allowedSubsidiaryIds === null
              ? undefined
              : inArray(departments.subsidiaryId, [...authz.allowedSubsidiaryIds]),
          ),
        )
        .limit(1)
    )[0];
    if (!existing) throw new ScopeNotFoundError();
    const custom = await validateDemandCustomValues(
      authz.user.orgId,
      body.custom,
      (existing.custom ?? {}) as Record<string, unknown>,
    );
    if (custom instanceof Response) return custom;
    return Response.json(
      await updateDemandLine({
        ...body,
        custom: custom.cleaned,
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        demandLineId: params.id,
      }),
    );
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
