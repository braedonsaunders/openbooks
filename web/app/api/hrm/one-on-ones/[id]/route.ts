import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import {
  cancelOneOnOne,
  getOneOnOne,
  holdOneOnOne,
  skipOneOnOne,
} from "@openbooks/engine/src/hrm/performance/one-on-ones.ts";

import { isFeatureEnabled } from "../../../../../lib/features";
import { performanceErrorResponse } from "../../review-cycles/_lib";
import { patchOneOnOneBody } from "../bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance")) &&
    (await isFeatureEnabled(orgId, "hrmOneOnOnes"))
  );
}

/**
 * One 1:1. GET reads it (private items filtered to their author);
 * PATCH holds (carries open items forward), skips with a reason, or
 * cancels. The client checks res.ok before parsing.
 */
export const GET = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ request: _req, authz: authz, params: routeParams }) => {
    if (!(await gated(authz.user.orgId))) {
      return notFound("record");
    }
    const { id } = routeParams;
    try {
      const one = await getOneOnOne({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        id,
      });
      return NextResponse.json({ oneOnOne: one });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});

export const PATCH = defineRoute({
  public: "session",
  params: z.object({ id: z.string().min(1) }),
  body: patchOneOnOneBody,
  handler: async ({
    request: req,
    authz: authz,
    params: routeParams,
    body: body,
  }) => {
    if (!(await gated(authz.user.orgId))) {
      return notFound("record");
    }

    const { id } = routeParams;
    try {
      if (body.action === "hold") {
        const one = await holdOneOnOne({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          id,
        });
        return NextResponse.json({ oneOnOne: one });
      }
      if (body.action === "skip") {
        const one = await skipOneOnOne({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          id,
          reason: body.reason,
        });
        return NextResponse.json({ oneOnOne: one });
      }
      await cancelOneOnOne({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        id,
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
