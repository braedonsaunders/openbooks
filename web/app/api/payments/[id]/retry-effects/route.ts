import { NextResponse } from "next/server";
import { z } from "zod";
import { assertAnyPermission, ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { PostingEffectsReplayError } from "@openbooks/engine/ledger/posting-effects";
import { paymentDocumentScope } from "@openbooks/engine/payments/payment-queries";
import { replayPaymentPostingEffect } from "@openbooks/engine/payments/payment-effect-recovery";
import type { PaymentKind } from "@openbooks/engine/payments/payment-contracts";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidId } from "@/lib/api/json";
import { notFound } from "@/lib/api/responses";
import { can, getAuthz, guardSubsidiaryScope, type Authz } from "@/lib/authz";
import { paymentPermission } from "../../lib";

export const runtime = "nodejs";

const retryEffectsParams = z.object({ id: uuidId });
const retryEffectsBody = z.object({ reason: z.string().trim().min(10).max(1000) }).strict();
const authorizedPaymentKinds = new WeakMap<Authz, PaymentKind>();

async function authorizePaymentEffect({ params, request }: { request: Request; params: unknown }) {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    assertAnyPermission((permission) => can(authz, permission), ["ar.pay", "ap.pay"]);
  } catch (error) {
    if (error instanceof ScopeNotFoundError) return notFound("record");
    throw error;
  }

  const id = (params as { id?: unknown } | undefined)?.id;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return authz;
  }
  if (!retryEffectsParams.safeParse({ id }).success || !retryEffectsBody.safeParse(body).success) {
    return authz;
  }
  const payment = await paymentDocumentScope(authz.user.orgId, id as string);
  if (!payment || !can(authz, paymentPermission(payment.kind))) return notFound("record");
  const denied = guardSubsidiaryScope(authz, payment.subsidiaryId);
  if (denied) return denied;
  authorizedPaymentKinds.set(authz, payment.kind);
  return authz;
}

/** Effect recovery queues the native outbox; it cannot submit, re-post or
 * change a payment's journal, allocation workpaper or lifecycle. */
export const POST = defineRoute({
  authorize: authorizePaymentEffect,
  feature: "banking",
  params: retryEffectsParams,
  body: retryEffectsBody,
  handler: async ({ authz, params, body }) => {
    const paymentKind = authorizedPaymentKinds.get(authz);
    if (!paymentKind) return notFound("record");
    try {
      // The kernel locks effect → document → live actor authority. It
      // rechecks requested scope, current duty, Banking and posted status
      // before the reasoned reset.
      const result = await replayPaymentPostingEffect({
        orgId: authz.user.orgId,
        paymentId: params.id,
        paymentKind,
        actorId: authz.user.id,
        reason: body.reason,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      });
      return result ? NextResponse.json(result) : notFound("record");
    } catch (error) {
      if (
        error instanceof ScopeNotFoundError ||
        (error instanceof PostingEffectsReplayError && error.cause instanceof ScopeNotFoundError)
      ) {
        return notFound("record");
      }
      if (error instanceof PostingEffectsReplayError)
        return apiErrorResponse(error, { safeStatus: 422 });
      throw error;
    }
  },
});
