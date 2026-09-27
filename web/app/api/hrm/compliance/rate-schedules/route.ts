import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  addScheduleLine,
  createSchedule,
  listScheduleLines,
  listSchedules,
  resolveWage,
  updateScheduleScope,
} from "@openbooks/engine/src/hrm/construction/rates.ts";
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
  handler: async ({ request: req, authz: gate, body }) => {
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
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    if (url.searchParams.get("resolve") === "1") {
      const parsedBody = await parseJsonBody(req, resolveWageBody);
      if (!parsedBody.ok) return parsedBody.response;
      try {
        const wage = await resolveWage(db, {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          employmentId: parsedBody.data.employmentId,
          projectId: parsedBody.data.projectId ?? null,
          workedOn: parsedBody.data.workedOn,
        });
        return NextResponse.json({ wage });
      } catch (e) {
        return constructionErrorResponse(e);
      }
    }
    if (url.searchParams.get("scope") === "1") {
      const scoped = await parseJsonBody(req, updateScheduleScopeBody);
      if (!scoped.ok) return scoped.response;
      try {
        const schedule = await updateScheduleScope(db, {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          scheduleId: scoped.data.scheduleId,
          appliesTo: scoped.data.appliesTo ?? {},
        });
        return NextResponse.json({ schedule });
      } catch (e) {
        return constructionErrorResponse(e);
      }
    }
    const parsedBody = await parseJsonBody(req, addScheduleLineBody);
    if (!parsedBody.ok) return parsedBody.response;
    try {
      const lineId = await addScheduleLine(db, {
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        ...parsedBody.data,
      });
      return NextResponse.json({ lineId }, { status: 201 });
    } catch (e) {
      return constructionErrorResponse(e);
    }
  },
});
