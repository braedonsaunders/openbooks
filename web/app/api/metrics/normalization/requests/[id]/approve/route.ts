import { approveAndExecuteNormalizationRequest } from "@openbooks/engine/src/billing/metrics/metrics-normalization-service.ts";
import { defineRoute } from "@/lib/api/route";
import { can, getAuthz } from "@/lib/authz";
import { NextResponse } from "next/server";
import { z } from "zod";

const Params = z.object({ id: z.string().uuid() });

/**
 * Approval establishes BOTH permissions before params/body parsing: the
 * requester holds usage.manage from filing, and only a distinct operator
 * holding close.reopen as well may approve. One session read feeds both
 * checks; the service refuses self-approval by name.
 */
export const POST = defineRoute({
  authorize: async () => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!can(authz, "usage.manage")) {
      return NextResponse.json({ error: "missing permission: usage.manage" }, { status: 403 });
    }
    if (!can(authz, "close.reopen")) {
      return NextResponse.json({ error: "missing permission: close.reopen" }, { status: 403 });
    }
    return authz;
  },
  feature: "saasMetrics",
  scope: "unrestricted",
  params: Params,
  handler: async ({ authz, params }) =>
    Response.json(
      await approveAndExecuteNormalizationRequest({
        orgId: authz.user.orgId,
        requestId: params.id,
        approverId: authz.user.id,
      }),
    ),
});
