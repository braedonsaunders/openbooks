import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  readScorecardsForInterview,
  submitScorecard,
} from "@openbooks/engine/src/hrm/recruiting/scorecards.ts";

import { recruitingErrorResponse } from "../../../_lib";
import { submitScorecardBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Interview scorecards: GET reads under the blind rule (own card plus
 * others only after submitting, unless privileged), POST submits the
 * actor's own verdict. The read gate is hrm.recruiting.read; submitting
 * needs a panel seat (checked in the service). 404s while hrm,
 * hrmRecruiting, or hrmStructuredInterviews is off.
 */
export const GET = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmStructuredInterviews",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    try {
      const cards = await readScorecardsForInterview({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        interviewId: id,
      });
      return NextResponse.json(cards);
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmStructuredInterviews",
  params: z.object({ id: z.string().min(1) }),
  body: submitScorecardBody,
  handler: async ({
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;

    try {
      const card = await submitScorecard({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        interviewId: id,
        overall: body.overall,
        ratings: body.ratings,
        privateNotes: body.privateNotes,
        sharedNotes: body.sharedNotes,
      });
      return NextResponse.json({ scorecard: card }, { status: 201 });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
