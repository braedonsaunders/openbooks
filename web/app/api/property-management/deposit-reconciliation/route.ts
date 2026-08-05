import { NextResponse } from "next/server";
import { securityDepositReconciliation } from "@openbooks/engine/src/property-management.ts";
import { sum } from "@openbooks/engine/src/money.ts";
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
    const reconciliation = await securityDepositReconciliation(
      authz.user.orgId,
      asOf,
    );
    if (!authz.allowedSubsidiaryIds)
      return NextResponse.json(reconciliation);
    const rows = reconciliation.rows.filter((row) =>
      authz.allowedSubsidiaryIds!.has(String(row.subsidiaryId)),
    );
    return NextResponse.json({
      ...reconciliation,
      rows,
      totals: {
        subledgerBalance: sum(rows.map((row) => row.subledgerBalance)),
        linkedGlBalance: sum(rows.map((row) => row.linkedGlBalance)),
        cashActivity: sum(rows.map((row) => row.cashActivity)),
        discrepancies: rows.filter((row) => row.status === "discrepancy")
          .length,
        configurationRequired: rows.filter(
          (row) => row.status === "configuration_required",
        ).length,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Reconciliation failed" },
      { status: 422 },
    );
  }
}
