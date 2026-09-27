import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  listPostings,
  publishPosting,
} from "@openbooks/engine/src/hrm/recruiting/postings.ts";

import { isFeatureEnabled } from "../../../../../lib/features";
import { recruitingErrorResponse } from "../_lib";
import { publishPostingBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Job-board postings: GET lists (optionally per requisition), POST
 * publishes one board (manage gate in the service). 404s while hrm,
 * hrmRecruiting, or hrmJobBoards is off.
 */
async function depthGate(orgId: string) {
  if (!(await isFeatureEnabled(orgId, "hrmRecruiting"))) return false;
  return isFeatureEnabled(orgId, "hrmJobBoards");
}

export const GET = defineRoute({
  permission: "hrm.recruiting.read",
  feature: "hrmJobBoards",
  handler: async ({ request: req, authz: gate }) => {
    try {
      const requisitionId =
        new URL(req.url).searchParams.get("requisitionId") ?? undefined;
      const postings = await listPostings({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requisitionId,
      });
      return NextResponse.json({ postings });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmJobBoards",
  body: publishPostingBody,
  handler: async ({ request: req, authz: gate, body: body }) => {
    try {
      const posting = await publishPosting({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        requisitionId: body.requisitionId,
        boardKey: body.boardKey,
      });
      return NextResponse.json({ posting }, { status: 201 });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
