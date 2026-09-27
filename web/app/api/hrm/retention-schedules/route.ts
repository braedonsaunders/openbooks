import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  listSchedules,
  saveSchedule,
} from "@openbooks/engine/src/hrm/documents/retention.ts";
import { hrmDocumentsErrorResponse } from "../documents/_lib";
import { saveScheduleBody } from "./bodies";
export const GET = defineRoute({
  permission: "hrm.documents.read",
  feature: "hrmDocumentRetention",
  handler: async ({ authz: gate }) => {
    try {
      const schedules = await listSchedules({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
      });
      return NextResponse.json({ schedules });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
export const POST = defineRoute({
  permission: "hrm.documents.manage",
  feature: "hrmDocumentRetention",
  body: saveScheduleBody,
  handler: async ({ request: _req, authz: gate, body }) => {
    try {
      const schedule = await saveSchedule({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        scheduleId: body.scheduleId,
        categoryKey: body.categoryKey,
        retainYears: body.retainYears,
        fromEvent: body.fromEvent,
        action: body.action,
        isActive: body.isActive,
      });
      return NextResponse.json(
        { schedule },
        { status: body.scheduleId ? 200 : 201 },
      );
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
