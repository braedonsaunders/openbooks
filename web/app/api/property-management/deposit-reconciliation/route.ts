import { NextResponse } from "next/server";
import { securityDepositReconciliation } from "@openbooks/engine/src/property/management.ts";
import { guardPermission } from "../../../../lib/authz";
import { guardPropertyManagementFeature } from "../../../../lib/property-management-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authz = await guardPermission("ar.read");
  if (authz instanceof NextResponse) return authz;
  const feature = await guardPropertyManagementFeature(authz.user.orgId);
  if (feature) return feature;
  const asOf = new URL(request.url).searchParams.get("asOf") ?? undefined;
  try {
    // The loader scopes every query to the caller inside one
    // repeatable-read snapshot and aggregates over the scoped rows:
    // filtering org-wide totals afterwards would tear across a rehome.
    const reconciliation = await securityDepositReconciliation(
      authz.user.orgId,
      authz.allowedSubsidiaryIds,
      asOf,
    );
    return NextResponse.json(reconciliation);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Reconciliation failed" },
      { status: 422 },
    );
  }
}
