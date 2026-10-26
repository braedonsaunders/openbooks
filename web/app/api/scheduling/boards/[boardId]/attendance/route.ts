import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { schedulingBoardRouteAuthority } from "@/lib/scheduling/board-route-authority";
import { processBoardAttendance } from "@openbooks/engine/schedule-boards/attendance";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Observe attendance for the board's started bookings in a date window. */
export const POST = defineRoute({
  authorize: ({ params }) => schedulingBoardRouteAuthority(params, "read"),
  feature: "hrmAttendance",
  params: z.object({ boardId: uuidString() }),
  body: z.strictObject({ from: date, through: date }),
  handler: async ({ authz, params, body }) =>
    NextResponse.json({
      outcomes: await processBoardAttendance({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        boardId: params.boardId,
        ...body,
      }),
    }),
});
