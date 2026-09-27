import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import {
  listFeedback,
  writeFeedback,
} from "@openbooks/engine/src/hrm/performance/feedback.ts";

import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { writeFeedbackBody } from "./bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance"))
  );
}

/**
 * Feedback. GET lists visibility-filtered rows (narrowed by
 * ?subjectEmploymentId); POST writes praise, feedback, or a request
 * (requests notify the requested party). The client checks res.ok
 * before parsing.
 */
export const GET = defineRoute({
  public: "session",
  handler: async ({ request: req, authz: authz }) => {
    if (!(await gated(authz.user.orgId))) {
      return notFound("record");
    }
    const subjectEmploymentId = new URL(req.url).searchParams.get(
      "subjectEmploymentId",
    );
    if (subjectEmploymentId !== null && !isUuid(subjectEmploymentId)) {
      return NextResponse.json(
        { error: "subjectEmploymentId must be a uuid" },
        { status: 400 },
      );
    }
    try {
      const rows = await listFeedback({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        ...(subjectEmploymentId ? { subjectEmploymentId } : {}),
      });
      return NextResponse.json({ feedback: rows });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  public: "session",
  body: writeFeedbackBody,
  handler: async ({ authz: authz, body: body }) => {
    if (!(await gated(authz.user.orgId))) {
      return notFound("record");
    }

    try {
      const row = await writeFeedback({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        subjectEmploymentId: body.subjectEmploymentId,
        kind: body.kind,
        visibility: body.visibility,
        body: body.body,
        context: body.context ?? null,
        requestedFromPartyId: body.requestedFromPartyId ?? null,
      });
      return NextResponse.json({ feedback: row }, { status: 201 });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
