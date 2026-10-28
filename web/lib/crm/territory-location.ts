import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/database";
import { SalesError, salesScopeWhere } from "@openbooks/engine/crm/sales";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "@openbooks/engine/organization/features";
import type { Authz } from "../authz";

export type TerritoryLocationInput = {
  longitude: number;
  latitude: number;
  expectedRevision: string;
  reason: string;
};

/** Verify one party address location with the same scope, lock and audit as Sales Setup. */
export async function verifyCrmTerritoryLocation(
  authz: Authz,
  addressId: string,
  input: TerritoryLocationInput,
): Promise<void> {
  const scope = {
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
  };
  await db.transaction(async (tx) => {
    await acquireOrgFeatureGateLock(tx, scope.orgId);
    if (!(await lockAndCheckOrgFeature(tx, scope.orgId, "geographicTerritories")))
      throw new SalesError("Geographic territories are disabled.", 404);
    const before = (
      await tx.execute<{ updated_at: string }>(
        sql`select a.*,a.updated_at::text as updated_at from addresses a join parties p on p.id=a.party_id and p.org_id=a.org_id where a.org_id=${scope.orgId} and a.id=${addressId} and ${salesScopeWhere(scope, sql`p.subsidiary_id`)} for update of a`,
        "objects",
      )
    )[0];
    if (!before) throw new SalesError("Address not found.", 404);
    if (before.updated_at !== input.expectedRevision)
      throw new SalesError(
        "This address changed. Preview again before verifying its location.",
        409,
      );
    const after = (
      await tx.execute(
        sql`update addresses set longitude=${input.longitude.toFixed(7)},latitude=${input.latitude.toFixed(7)},location_verified_at=now(),location_verified_by=${scope.actorId},updated_at=clock_timestamp(),updated_by=${scope.actorId} where org_id=${scope.orgId} and id=${addressId} returning *`,
        "objects",
      )
    )[0];
    if (!after) throw new SalesError("Address location was not verified.", 409);
    await tx.execute(
      sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${scope.orgId},'addresses',${addressId},'update',${JSON.stringify({ before, after, reason: input.reason })}::jsonb,${scope.actorId})`,
    );
  });
}
