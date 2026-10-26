import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { parseJsonBody } from "@/lib/api/json";
import {
  createAdjustingAward,
  getBenefitAward,
  queueAwardForPayRun,
  queueBenefitAward,
  recordExternalDelivery,
  recordPayrollDelivery,
  submitBenefitAward,
  voidBenefitAward,
} from "@openbooks/engine/hrm/benefits";
import { db } from "@openbooks/engine/platform/database";
import { can, getAuthz } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { benefitsErrorResponse } from "../../benefits/_lib";
import { benefitAwardPatchBody } from "../bodies";

export const runtime = "nodejs";
const awardParams = z.object({ id: z.string().min(1) });

/**
 * One reward's lifecycle: native workflow submission, payroll queue,
 * record payroll or external delivery, or void with a reason. The grant
 * follows the move — HR authors with hrm.benefits.manage, finance releases
 * payout with payroll.manage — enforced again inside the engine.
 */
export const GET = defineRoute({
  permission: "hrm.benefits.read",
  feature: "hrm",
  params: awardParams,
  handler: async ({ authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json({ error: "award id must be a uuid" }, { status: 400 });
    try {
      const award = await getBenefitAward(db, gate.user.orgId, gate.user.id, id);
      return NextResponse.json({ award });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});

export const PATCH = defineRoute({
  authorize: async ({ request, params }) => {
    const authz = await getAuthz();
    if (!authz) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const routeParams = awardParams.safeParse(params);
    if (!routeParams.success) {
      return NextResponse.json(
        { error: routeParams.error.issues[0]?.message ?? "invalid request parameters" },
        { status: 400 },
      );
    }
    if (!isUuid(routeParams.data.id)) {
      return NextResponse.json({ error: "award id must be a uuid" }, { status: 400 });
    }
    // The validated body selects the grant, so malformed input must keep its
    // body refusal before any action-specific permission refusal.
    const parsedBody = await parseJsonBody(request.clone(), benefitAwardPatchBody);
    if (!parsedBody.ok) return parsedBody.response;
    const financeMove =
      parsedBody.data.action === "queue" ||
      parsedBody.data.action === "payrollDelivery" ||
      parsedBody.data.action === "externalDelivery";
    const permission = financeMove ? "payroll.manage" : "hrm.benefits.manage";
    return can(authz, permission)
      ? authz
      : NextResponse.json({ error: `missing permission: ${permission}` }, { status: 403 });
  },
  feature: "hrm",
  params: awardParams,
  body: benefitAwardPatchBody,
  handler: async ({ params: routeParams, body, authz: gate }) => {
    const { id } = routeParams;
    const base = { orgId: gate.user.orgId, actorId: gate.user.id, awardId: id };
    try {
      switch (body.action) {
        case "submit": {
          const award = await submitBenefitAward(base);
          return NextResponse.json({ award });
        }
        case "queue": {
          if (body.payRunDocumentId && !body.payRunAdjustmentId) {
            const queued = await queueAwardForPayRun({
              orgId: base.orgId,
              actorId: base.actorId,
              awardId: base.awardId,
              runDocumentId: body.payRunDocumentId,
            });
            return NextResponse.json({ award: queued.award });
          }
          const award = await queueBenefitAward({
            ...base,
            payRunDocumentId: body.payRunDocumentId ?? null,
            payRunAdjustmentId: body.payRunAdjustmentId ?? null,
          });
          return NextResponse.json({ award });
        }
        case "payrollDelivery": {
          const award = await recordPayrollDelivery({
            ...base,
            payRunDocumentId: body.payRunDocumentId,
            payRunAdjustmentId: body.payRunAdjustmentId,
          });
          return NextResponse.json({ award });
        }
        case "externalDelivery": {
          const award = await recordExternalDelivery({ ...base, externalRef: body.externalRef });
          return NextResponse.json({ award });
        }
        case "adjust": {
          const award = await createAdjustingAward({
            ...base,
            correctionId: body.correctionId,
            value: body.value,
            reason: body.reason,
            ...(body.sourceReference === undefined
              ? {}
              : { sourceReference: body.sourceReference }),
            ...(body.periodFrom === undefined
              ? {}
              : { periodFrom: body.periodFrom, periodTo: body.periodTo! }),
          });
          return NextResponse.json({ award });
        }
        case "void": {
          const award = await voidBenefitAward({ ...base, reason: body.reason });
          return NextResponse.json({ award });
        }
      }
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});
