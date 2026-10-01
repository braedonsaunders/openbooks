import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { defineRoute } from "@/lib/api/route";
import { db } from "@openbooks/engine/platform/database";
import { salesScopeWhere, SalesError } from "@openbooks/engine/crm/sales";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "@openbooks/engine/organization/features";

export const runtime = "nodejs";
export const PATCH = defineRoute({
  permission: "crm.accounts.manage",
  feature: "geographicTerritories",
  params: z.object({ id: z.string().uuid() }),
  body: z.strictObject({
    longitude: z.number().min(-180).max(180),
    latitude: z.number().min(-90).max(90),
    expectedRevision: z.string(),
    reason: z.string().trim().min(1).max(1000),
  }),
  handler: async ({ authz, params, body }) => {
    const scope = {
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    };
    await db.transaction(async (tx) => {
      await acquireOrgFeatureGateLock(tx, scope.orgId);
      if (
        !(await lockAndCheckOrgFeature(
          tx,
          scope.orgId,
          "geographicTerritories",
        ))
      )
        throw new SalesError("Geographic territories are disabled.", 404);
      const before = (
        await tx.execute<{ updated_at: string }>(
          sql`select a.*,a.updated_at::text as updated_at from addresses a join parties p on p.id=a.party_id and p.org_id=a.org_id where a.org_id=${scope.orgId} and a.id=${params.id} and ${salesScopeWhere(scope, sql`p.subsidiary_id`)} for update of a`,
        )
      ).rows[0];
      if (!before) throw new SalesError("Address not found.", 404);
      if (before.updated_at !== body.expectedRevision)
        throw new SalesError(
          "This address changed. Preview again before verifying its location.",
          409,
        );
      const after = (
        await tx.execute(
          sql`update addresses set longitude=${body.longitude.toFixed(7)},latitude=${body.latitude.toFixed(7)},location_verified_at=now(),location_verified_by=${scope.actorId},updated_at=clock_timestamp(),updated_by=${scope.actorId} where org_id=${scope.orgId} and id=${params.id} returning *`,
        )
      ).rows[0];
      if (!after)
        throw new SalesError("Address location was not verified.", 409);
      await tx.execute(
        sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${scope.orgId},'addresses',${params.id},'update',${JSON.stringify({ before, after, reason: body.reason })}::jsonb,${scope.actorId})`,
      );
    });
    return NextResponse.json({ ok: true });
  },
});
