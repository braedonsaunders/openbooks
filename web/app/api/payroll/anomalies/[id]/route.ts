import { defineRoute } from '@/lib/api/route'
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveFlag } from "@openbooks/engine/src/hrm/ai/anomalies.ts";
import { aiRailsErrorResponse } from "../../../../../lib/ai-rails";
import { can } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";


export const runtime = "nodejs";

const transitionBody = z.object({
  to: z.enum(["acknowledged", "resolved", "false_positive"]),
  reason: z.string().min(1).max(500),
});

/**
 * Transition one flag. Acknowledge, resolve, or mark false-positive —
 * every target needs the reason the audit keeps. Blocking flags resolve
 * or dismiss only through the payroll manager (enforced in the service);
 * false-positives feed the per-org suppression list. One transaction.
 */
export const PATCH = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  body: transitionBody,
  handler: async ({ params, body, authz: gate }) => {
  if (!("payroll.manage time.approve hrm.employment.read".split(" ")).some((permission) => can(gate, permission))) {
    return NextResponse.json({ error: "missing permission: one of payroll.manage, time.approve, hrm.employment.read" }, { status: 403 });
  }
  if (
    !(await isFeatureEnabled(gate.user.orgId, "payroll")) &&
    !(await isFeatureEnabled(gate.user.orgId, "timeTracking"))
  ) {
    return notFound("record");
  }
  const { id } = params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "flag id must be a uuid" }, { status: 400 });
  }
  try {
    const flag = await resolveFlag({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      flagId: id,
      to: body.to,
      reason: body.reason,
    });
    return NextResponse.json({ flag });
  } catch (e) {
    return aiRailsErrorResponse(e);
  }
  },
})
