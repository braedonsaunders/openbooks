import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { authorizeService, serviceActor } from "@/lib/service/authority";
import { loadDispatchDay } from "@openbooks/engine/service/dispatch";
import { dispatchQuery } from "@/lib/service/schemas";

export const runtime = "nodejs";

/** One dispatch day: technician columns with their bookings and availability, and the unscheduled queue. */
export const GET = defineRoute({
  authorize: authorizeService("service.read", "service.manage", "service.dispatch"),
  feature: "serviceDispatch",
  handler: async ({ authz, request }) => {
    const search = new URL(request.url).searchParams;
    const parsed = dispatchQuery.safeParse({
      board: search.get("board"),
      date: search.get("date"),
    });
    if (!parsed.success)
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Choose a dispatch board and a date." },
        { status: 400 },
      );
    const sla = search.get("sla");
    const filters = {
      priorities: search
        .getAll("priority")
        .filter((value): value is "low" | "normal" | "high" | "urgent" =>
          ["low", "normal", "high", "urgent"].includes(value),
        ),
      qualificationTypeId: search.get("skill") || null,
      area: search.get("area") || null,
      sla: (sla === "breached" || sla === "due_today" || sla === "due_soon" ? sla : "any") as
        "any" | "breached" | "due_today" | "due_soon",
      search: search.get("q") || null,
    };
    return NextResponse.json(
      await loadDispatchDay({
        ...serviceActor(authz),
        boardId: parsed.data.board,
        date: parsed.data.date,
        filters,
      }),
    );
  },
});
