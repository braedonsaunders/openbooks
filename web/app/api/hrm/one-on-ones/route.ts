import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import {
  listOneOnOnes,
  scheduleOneOnOne,
} from "@openbooks/engine/src/hrm/performance/one-on-ones.ts";

import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { performanceErrorResponse } from "../review-cycles/_lib";
import { scheduleOneOnOneBody } from "./bodies";

export const runtime = "nodejs";

async function gated(orgId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled(orgId, "hrm")) &&
    (await isFeatureEnabled(orgId, "hrmPerformance")) &&
    (await isFeatureEnabled(orgId, "hrmOneOnOnes"))
  );
}

/**
 * 1:1s. GET lists the actor's visible 1:1s (the pair, the line manager,
 * or HR scope — narrowed by ?employmentId and ?status); POST schedules
 * one (either party may propose; a third party must manage the report).
 * The client checks res.ok before parsing.
 */
export const GET = defineRoute({
  public: "session",
  handler: async ({ request: req, authz: authz }) => {
    if (!(await gated(authz.user.orgId))) {
      return notFound("record");
    }
    const params = new URL(req.url).searchParams;
    const employmentId = params.get("employmentId");
    const status = params.get("status");
    if (employmentId !== null && !isUuid(employmentId)) {
      return NextResponse.json(
        { error: "employmentId must be a uuid" },
        { status: 400 },
      );
    }
    if (
      status !== null &&
      !["scheduled", "held", "skipped", "cancelled"].includes(status)
    ) {
      return NextResponse.json(
        { error: "status must be scheduled, held, skipped, or cancelled" },
        { status: 400 },
      );
    }
    try {
      const ones = await listOneOnOnes({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        ...(employmentId ? { employmentId } : {}),
        ...(status
          ? { status: status as "scheduled" | "held" | "skipped" | "cancelled" }
          : {}),
      });
      return NextResponse.json({ oneOnOnes: ones });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  public: "session",
  body: scheduleOneOnOneBody,
  handler: async ({ request: req, authz: authz, body: body }) => {
    if (!(await gated(authz.user.orgId))) {
      return notFound("record");
    }

    try {
      const one = await scheduleOneOnOne({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        managerEmploymentId: body.managerEmploymentId,
        reportEmploymentId: body.reportEmploymentId,
        scheduledAt: body.scheduledAt,
        recurrence:
          body.recurrence === undefined
            ? null
            : body.recurrence === null
              ? null
              : {
                  every_weeks: body.recurrence.every_weeks,
                  weekday: body.recurrence.weekday,
                  time: body.recurrence.time ?? undefined,
                },
      });
      return NextResponse.json({ oneOnOne: one }, { status: 201 });
    } catch (e) {
      return performanceErrorResponse(e);
    }
  },
});
