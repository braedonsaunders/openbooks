import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import {
  PaymentAcceptanceError,
  voidPaymentLink,
} from "@openbooks/engine/payments/acceptance/operations";
import { paymentLinkScope } from "@openbooks/engine/payments/payment-queries";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { guardPermission, guardSubsidiaryScope, type Authz } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

async function deletePaymentLink({ params }: { params: Promise<{ id: string }> }, gate: Authz) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  // Void is a payment-link record boundary: the stored legal entity is
  // loaded with the org probe, then the shared gate runs before the
  // bearer token can be cancelled. Missing and out-of-scope links both
  // 404, matching /api/documents/[id] and /api/payments/[id].
  const owned = await paymentLinkScope(gate.user.orgId, id);
  if (!owned) return notFound("record");
  const denied = guardSubsidiaryScope(gate, owned.subsidiaryId);
  if (denied) return denied;
  try {
    await voidPaymentLink(gate.user.orgId, gate.user.id, id, gate.allowedSubsidiaryIds);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ScopeNotFoundError) return notFound("record");
    if (e instanceof PaymentAcceptanceError) return apiErrorResponse(e, { safeStatus: 422 });
    return apiErrorResponse(e);
  }
}

export const DELETE = defineRoute({
  authorize: () => guardPermission("ar.create"),
  feature: "onlinePayments",
  params: z.object({ id: z.string() }),
  handler: async ({ params, authz }) =>
    deletePaymentLink({ params: Promise.resolve(params) }, authz),
});
