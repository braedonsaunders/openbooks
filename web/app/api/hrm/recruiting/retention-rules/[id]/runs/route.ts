import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  evaluateRetentionRule,
  listRetentionRuns,
} from "@openbooks/engine/src/hrm/recruiting/retention.ts";

import { recruitingErrorResponse } from "../../../_lib";

export const runtime = "nodejs";

/**
 * Retention runs: GET lists the run ledger, POST evaluates the rule once.
 * The service enforces the manage grant plus the runner's employer scope —
 * a scoped runner's manual run touches only owned candidates; the scheduled
 * system tick calls the same service as system for org-wide coverage.
 * Every evaluation appends exactly one run row. 404s while hrm,
 * hrmRecruiting, or hrmCandidateRetention is off.
 */
export const GET = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmCandidateRetention",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    try {
      const runs = await listRetentionRuns({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ruleId: id,
      });
      return NextResponse.json({ runs });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmCandidateRetention",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    try {
      const run = await evaluateRetentionRule({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ruleId: id,
      });
      return NextResponse.json({ run }, { status: 201 });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
