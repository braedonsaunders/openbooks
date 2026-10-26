import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { securityDepositReconciliation } from "@openbooks/engine/property/management";
import type { Authz } from "@/lib/authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function legacyGET(request: Request, authz: Authz) {
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
    return apiErrorResponse(error);
  }
}

export const GET = defineRoute({
  permission: "ar.read",
  feature: "propertyManagement",
  handler: async ({ request, authz }) => legacyGET(request, authz),
});
