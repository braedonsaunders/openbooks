import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  approveBenefitAward,
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
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { notFound } from "@/lib/api/responses";
import { isUuid } from "../../../../../lib/list-params";
import { benefitsErrorResponse } from "../../benefits/_lib";
import { benefitAwardPatchBody } from "../bodies";

export const runtime = "nodejs";

/**
 * One award's lifecycle: submit, approve (second actor), queue for payout,
 * record payroll or external delivery, or void with a reason. The grant
 * follows the move — HR authors with hrm.benefits.manage, finance releases
 * payout with payroll.manage — enforced again inside the engine.
 */
export const GET = defineRoute({
  permission: "hrm.benefits.read",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    if (!isUuid(id)) return NextResponse.json({ error: "award id must be a uuid" }, { status: 400 });
    try {
      const award = await getBenefitAward(db, gate.user.orgId, gate.user.id, id);
      return NextResponse.json({ award });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});

export const PATCH = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1) }),
  body: benefitAwardPatchBody,
  handler: async ({ params: routeParams, body }) => {
    const { id } = routeParams;
    if (!isUuid(id)) return NextResponse.json({ error: "award id must be a uuid" }, { status: 400 });
    const financeMove = body.action === "queue" || body.action === "payrollDelivery" || body.action === "externalDelivery";
    const gate = await guardPermission(financeMove ? "payroll.manage" : "hrm.benefits.manage");
    if (gate instanceof NextResponse) return gate;
    if (!(await isFeatureEnabled(gate.user.orgId, "hrm"))) {
      return notFound("record");
    }
    const base = { orgId: gate.user.orgId, actorId: gate.user.id, awardId: id };
    try {
      switch (body.action) {
        case "submit": {
          const award = await submitBenefitAward(base);
          return NextResponse.json({ award });
        }
        case "approve": {
          const award = await approveBenefitAward(base);
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
          const award = await createAdjustingAward({ ...base, correctionId: body.correctionId, value: body.value, reason: body.reason });
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
