import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import {
  EntitlementError,
  getEntitlementSnapshot,
  listPlanVersionEntitlements,
  listSaasFeatures,
} from "@openbooks/engine/billing";
import { guardUnrestrictedScope } from "../../../../lib/authz";
import { POSTBodySchema, executeEntitlementAction } from "@/lib/subscriptions/entitlement-actions";

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "ar.read",
  feature: "advancedSubscriptions",
  handler: async ({ authz, request }) => {
    const url = new URL(request.url);
    const subscriptionId = url.searchParams.get("subscriptionId");
    const planVersionId = url.searchParams.get("planVersionId");
    const features = url.searchParams.get("features");
    const at = url.searchParams.get("at");
    const provided = [subscriptionId, planVersionId, features].filter((value) => value !== null);
    if (provided.length !== 1) {
      return NextResponse.json(
        { error: "Supply exactly one of subscriptionId, planVersionId or features=1" },
        { status: 400 },
      );
    }
    try {
      if (features !== null) {
        const scopeDenied = guardUnrestrictedScope(authz);
        if (scopeDenied) return scopeDenied;
        return NextResponse.json({ ok: true, features: await listSaasFeatures(authz.user.orgId) });
      }
      if (planVersionId !== null) {
        const scopeDenied = guardUnrestrictedScope(authz);
        if (scopeDenied) return scopeDenied;
        const entitlements = await listPlanVersionEntitlements(
          authz.user.orgId,
          planVersionId,
          at ?? undefined,
        );
        return NextResponse.json({ ok: true, entitlements });
      }
      const snapshot = await getEntitlementSnapshot(authz.user.orgId, subscriptionId as string, {
        at: at ?? undefined,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      });
      return NextResponse.json({ ok: true, snapshot });
    } catch (error) {
      if (error instanceof EntitlementError) return apiErrorResponse(error);
      throw error;
    }
  },
});

export const POST = defineRoute({
  permission: "ar.create",
  feature: "advancedSubscriptions",
  body: POSTBodySchema,
  opaque: { limit: "limits are parsed to exact decimals in the handler with a named 422" },
  handler: ({ authz, body }) => executeEntitlementAction(authz, body),
});
