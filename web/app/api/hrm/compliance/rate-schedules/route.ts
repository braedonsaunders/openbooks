import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@openbooks/engine/platform/db";
import {
  addScheduleLine,
  createSchedule,
  listScheduleLines,
  listSchedules,
  resolveWage,
  updateScheduleScope,
} from "@openbooks/engine/hrm/construction/rates";
import { constructionErrorResponse } from "../_lib";
import {
  addScheduleLineBody,
  createScheduleBody,
  resolveWageBody,
  updateScheduleScopeBody,
} from "../bodies";
/** Rate schedules: prevailing-wage, union-agreement, org-declared. */
export const GET = defineRoute({
  permission: "hrm.construction.read",
  feature: "hrmConstructionCompliance",
  handler: async ({ request: req, authz: gate }) => {
    try {
      const scheduleId = new URL(req.url).searchParams.get("scheduleId");
      if (scheduleId) {
        const editor = await listScheduleLines(db, {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          scheduleId,
        });
        return NextResponse.json(editor);
      }
      const schedules = await listSchedules(db, gate.user.orgId, gate.user.id);
      return NextResponse.json({ schedules });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.construction.manage",
  feature: "hrmConstructionCompliance",
  body: createScheduleBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const schedule = await createSchedule(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...body,
      });
      return NextResponse.json({ schedule }, { status: 201 });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
/** Schedule lines and single-day wage resolution share this route file. */
export const PUT = defineRoute({
  permission: "hrm.construction.manage",
  feature: "hrmConstructionCompliance",
  body: ({ request }) => {
    const params = new URL(request.url).searchParams;
    return params.get("resolve") === "1"
      ? resolveWageBody
      : params.get("scope") === "1"
        ? updateScheduleScopeBody
        : addScheduleLineBody;
  },
  handler: async ({ request: req, authz: gate, body }) => {
    const url = new URL(req.url);
    if (url.searchParams.get("resolve") === "1") {
      const parsedBody = body as z.output<typeof resolveWageBody>;
      try {
        const wage = await resolveWage(db, {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          employmentId: parsedBody.employmentId,
          projectId: parsedBody.projectId ?? null,
          workedOn: parsedBody.workedOn,
        });
        return NextResponse.json({ wage });
      } catch (e) {
        return constructionErrorResponse(e);
      }
    }
    if (url.searchParams.get("scope") === "1") {
      const scoped = body as z.output<typeof updateScheduleScopeBody>;
      try {
        const schedule = await updateScheduleScope(db, {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          scheduleId: scoped.scheduleId,
          appliesTo: scoped.appliesTo ?? {},
        });
        return NextResponse.json({ schedule });
      } catch (e) {
        return constructionErrorResponse(e);
      }
    }
    const parsedBody = body as z.output<typeof addScheduleLineBody>;
    try {
      const lineId = await addScheduleLine(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...parsedBody,
      });
      return NextResponse.json({ lineId }, { status: 201 });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
