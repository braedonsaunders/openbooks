import type { SqlExecutor } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { refuse } from "./asset-refusal.ts";

/** The fixed-asset capabilities these services gate on, with their switch names. */
export const ASSET_DEPTH_FEATURES = {
  assetComponents: "Compound assets",
  assetProposals: "Asset proposals",
  constructionInProgress: "Construction in progress",
  assetMaintenance: "Asset maintenance",
  assetInsurance: "Asset insurance",
} as const;

export type AssetDepthFeature = keyof typeof ASSET_DEPTH_FEATURES;

/**
 * Recheck, inside the writing transaction, that the actor holds the
 * permission, the organization has the capability switched on (the registry
 * resolves Fixed Assets as its parent), and every legal entity the write
 * touches is inside the actor's authorization. The HTTP boundary checks the
 * same things first; this keeps jobs, imports and direct callers honest.
 */
export async function assertAssetAccess(
  tx: SqlExecutor,
  args: {
    orgId: string;
    actorId: string | null;
    permission: string;
    feature: AssetDepthFeature;
    subsidiaryIds: readonly string[];
  },
): Promise<void> {
  if (!args.actorId || !(await actorHasPermission(tx, args.orgId, args.actorId, args.permission))) {
    refuse("permission_required", `this action requires the ${args.permission} permission`, {
      status: 403,
      remedy: "Ask an administrator to grant the permission on your role in Settings → Roles.",
    });
  }
  if (!(await lockAndCheckOrgFeature(tx, args.orgId, args.feature))) {
    refuse(
      "feature_disabled",
      `${ASSET_DEPTH_FEATURES[args.feature]} is switched off for this organization`,
      {
        status: 409,
        remedy: `Turn on ${ASSET_DEPTH_FEATURES[args.feature]} under Fixed Assets in Company Settings → Features.`,
      },
    );
  }
  const allowed = await actorAllowedSubsidiaryIds(tx, args.orgId, args.actorId);
  if (allowed && args.subsidiaryIds.some((id) => !allowed.has(id))) {
    refuse("subsidiary_scope", "this record belongs to a legal entity outside your authorization", {
      status: 404,
    });
  }
}
