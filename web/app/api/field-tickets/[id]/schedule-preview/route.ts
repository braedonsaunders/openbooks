import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { calendarDaysBetween, isIsoCalendarDate } from "@openbooks/engine/platform/civil-date";
import { scheduledWork } from "@openbooks/engine/schedule-boards/prefill";
import { defineRoute } from "@/lib/api/route";
import { guardSubsidiaryScope } from "@/lib/authz";
import {
  activeEmployeePartyIds,
  fieldTicketScheduleTimeTypes,
  loadFieldTicket,
  readActiveProjectForTicket,
} from "@/lib/field-tickets";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const querySchema = z
  .object({
    projectId: uuidString(),
    from: z.string().refine(isIsoCalendarDate),
    through: z.string().refine(isIsoCalendarDate),
  })
  .refine(
    ({ from, through }) =>
      isIsoCalendarDate(from) &&
      isIsoCalendarDate(through) &&
      through >= from &&
      calendarDaysBetween(from, through) < 14,
  );

/** Preview only: the ticket's revision-fenced grid save records actual work. */
export const GET = defineRoute({
  permission: "time.manage",
  feature: "fieldTickets",
  params: z.object({ id: uuidString() }),
  handler: async ({ request, authz, params }) => {
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success)
      return NextResponse.json(
        { error: "Choose a project and a ticket period of at most fourteen days." },
        { status: 422 },
      );
    const { projectId, from, through } = parsed.data;
    const orgId = authz.user.orgId;
    const ticket = await loadFieldTicket(orgId, params.id, {
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    });
    if (ticket.status !== "draft")
      return NextResponse.json(
        { error: "Only draft field tickets can be filled from the schedule." },
        { status: 409 },
      );
    const project = await readActiveProjectForTicket(orgId, projectId);
    if (!project) return notFound("record");
    const denied = guardSubsidiaryScope(authz, project.subsidiaryId);
    if (denied) return denied;
    if (ticket.subsidiaryId && ticket.subsidiaryId !== project.subsidiaryId)
      return notFound("record");
    const scheduled = await scheduledWork({ orgId, use: "fieldTickets", projectId, from, through });
    const timeTypes = await fieldTicketScheduleTimeTypes(orgId);
    if (scheduled.length > 0 && timeTypes.length === 0) {
      return NextResponse.json(
        {
          error:
            "Set up an active regular time type shown on field tickets before filling from the schedule.",
        },
        { status: 422 },
      );
    }
    const eligible = await activeEmployeePartyIds(orgId, project.subsidiaryId);
    if (scheduled.some((work) => !eligible.has(work.workerPartyId))) {
      return NextResponse.json(
        {
          error:
            "Some scheduled people are no longer active employees in this project’s legal entity. Update those bookings before filling the ticket.",
        },
        { status: 422 },
      );
    }
    return NextResponse.json({ scheduled, timeTypes });
  },
});
