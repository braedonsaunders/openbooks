import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  closePosting,
  pausePosting,
} from "@openbooks/engine/src/hrm/recruiting/postings.ts";

import { recruitingErrorResponse } from "../../_lib";
import { transitionPostingBody } from "../bodies";

export const runtime = "nodejs";

/**
 * One job-board posting: POST pause/close (manage gate in the service).
 * Closed postings stay closed. 404s while HRM or Recruiting is
 * off.
 */
export const POST = defineRoute({
  permission: "hrm.recruiting.manage",
  feature: "hrmRecruiting",
  params: z.object({ id: z.string().min(1) }),
  body: transitionPostingBody,
  handler: async ({
    authz: gate,
    params: routeParams,
    body: body,
  }) => {
    const { id } = routeParams;

    try {
      const posting =
        body.action === "pause"
          ? await pausePosting({
              orgId: gate.user.orgId,
              actorId: gate.user.id,
              postingId: id,
            })
          : await closePosting({
              orgId: gate.user.orgId,
              actorId: gate.user.id,
              postingId: id,
            });
      return NextResponse.json({ posting });
    } catch (e) {
      return recruitingErrorResponse(e);
    }
  },
});
