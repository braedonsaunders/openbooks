import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import { getCandidateDetail } from "@openbooks/engine/src/hrm/recruiting/recruiting-read.ts";

import { isUuid } from "../../../../../../lib/list-params";
import { recruitingErrorResponse } from "../../_lib";

export const runtime = "nodejs";

/**
 * One candidate: GET resolves the drawer (applications, interviews) with
 * contact PII redacted unless the viewer holds hrm.recruiting.read — the
 * hiring manager reaches their own funnel's candidates here.
 */
export const GET = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmRecruiting",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid candidate" }, { status: 400 });
    try {
      const candidate = await getCandidateDetail({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        candidateId: id,
      });
      return NextResponse.json({ candidate });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
