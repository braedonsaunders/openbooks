import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { can, getAuthz, guardPermission } from "@/lib/authz";
import { uuidId } from "@/lib/api/json";
import {
  previewSignOffRevalidation,
  revalidateReconciliationSignOff,
} from "@openbooks/engine/banking/banking";

export const runtime = "nodejs";
const params = z.strictObject({ id: uuidId });

async function authorizeReview() {
  const authz = await getAuthz();
  if (authz && (can(authz, "banking.review_sign_off") || can(authz, "banking.reconcile")))
    return authz;
  return guardPermission("banking.review_sign_off");
}

export const GET = defineRoute({
  authorize: authorizeReview,
  feature: "banking",
  params,
  handler: async ({ authz, params }) =>
    NextResponse.json(
      await previewSignOffRevalidation(params.id, {
        orgId: authz.user.orgId,
        userId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      }),
    ),
});

export const POST = defineRoute({
  authorize: authorizeReview,
  feature: "banking",
  params,
  body: z.strictObject({
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().min(10).max(500),
  }),
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await revalidateReconciliationSignOff(params.id, body, {
        orgId: authz.user.orgId,
        userId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      }),
    ),
});
