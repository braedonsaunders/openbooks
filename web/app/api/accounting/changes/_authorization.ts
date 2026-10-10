import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  assertAnyPermission,
  ScopeNotFoundError,
} from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { getAuthz, can } from "@/lib/authz";
import { isFeatureEnabled } from "@/lib/features";
import { isUuid } from "@/lib/list-params";
export const changeAuthority = {
  manufacturing: {permission: "manufacturing.manage", feature: "manufacturing"},
  payroll: { permission: "payroll.run", feature: "payroll" },
  sales: {permission:"ar.post",feature:"dropShipping"},
  provision: { permission: "gl.manage", applyPermission: "gl.post", feature: null },
  lease: { permission: "assets.manage", feature: "fixedAssets" },
  asset: { permission: "assets.manage", feature: "fixedAssets" },
  revenue: { permission: "ar.post", feature: "revenueRecognition" },
  consolidation: { permission: "close.run", feature: "multiSubsidiary" },
} as const;
export async function authorizeChange(id: string, intent: "submit" | "apply" = "submit") {
  const auth = await getAuthz();
  if (!auth)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isUuid(id))
    return NextResponse.json({ error: "invalid change" }, { status: 422 });
  // Permission before existence (canonical shape 4 in
  // engine/src/organization/subsidiary-scope.ts): a caller holding none of
  // the change-family permissions learns nothing — existing and missing ids
  // answer the same uniform 404, never a 403 naming the needed permission.
  try {
    assertAnyPermission(
      (permission) => can(auth, permission),
      Object.values(changeAuthority).flatMap((entry) => [entry.permission, ...("applyPermission" in entry ? [entry.applyPermission] : [])]),
    );
  } catch (error) {
    if (error instanceof ScopeNotFoundError)
      return NextResponse.json({ error: "change not found" }, { status: 404 });
    throw error;
  }
  const row = (
    await db.execute<{
      domain: keyof typeof changeAuthority;
      operation: string;
      subsidiary_id: string;
      required_subsidiary_ids: string[] | null;
    }>(
      sql`select domain,operation,subsidiary_id,payload->'requiredSubsidiaryIds' as required_subsidiary_ids from financial_changes where org_id=${auth.user.orgId} and id=${id}`,
    )
  ).rows[0];
  if (
    !row ||
    (auth.allowedSubsidiaryIds &&
      [row.subsidiary_id, ...(row.required_subsidiary_ids ?? [])].some(
        (id) => !auth.allowedSubsidiaryIds!.has(id),
      ))
  )
    return NextResponse.json({ error: "change not found" }, { status: 404 });
  const policy = changeAuthority[row.domain];
  // Wrong-domain callers learn nothing either: the domain-specific
  // permission fails closed with the same uniform 404, so an ar.post-only
  // caller cannot distinguish an existing lease change from a missing id.
  if (!policy || !can(auth, intent === "apply" && "applyPermission" in policy ? policy.applyPermission : policy.permission))
    return NextResponse.json({ error: "change not found" }, { status: 404 });
  if (policy.feature && !(row.domain === "consolidation" && row.operation === "net_investment_oci_reversal") && !(await isFeatureEnabled(auth.user.orgId, policy.feature)))
    return NextResponse.json(
      {
        error:
          "accounting capability is disabled in Company Settings → Features",
      },
      { status: 422 },
    );
  return { auth, domain: row.domain, operation: row.operation };
}
