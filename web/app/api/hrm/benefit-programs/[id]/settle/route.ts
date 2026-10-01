import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { settleIncentivePeriod } from "@openbooks/engine/hrm/benefits";
import { isUuid } from "@/lib/list-params";
import { benefitsErrorResponse } from "@/app/api/hrm/benefits/_lib";

/**
 * Settle a closed period: lock, freeze facts, and record one draft award
 * per payable recipient, atomically and idempotently. Awards are created
 * draft — approval stays with a second actor, queuing with finance, and
 * delivery records only after the pay run commits.
 */
export const runtime = "nodejs";

const settleBody = z.object({
  periodFrom: z.string().min(1),
  periodTo: z.string().min(1),
});

export const POST = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  body: settleBody,
  handler: async ({ authz: gate, params: routeParams, body }) => {
    const { id } = routeParams;
    if (!isUuid(id)) return NextResponse.json({ error: "program id must be a uuid" }, { status: 400 });
    try {
      const settled = await settleIncentivePeriod({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        programId: id,
        periodFrom: body.periodFrom,
        periodTo: body.periodTo,
      });
      return NextResponse.json({ awards: settled.awards, preview: settled.preview });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});
