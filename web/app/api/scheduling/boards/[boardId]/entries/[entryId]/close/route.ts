import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { schedulingBoardRouteAuthority } from "@/lib/scheduling/board-route-authority";
import { closeShift } from "@openbooks/engine/schedule-boards/attendance";

/** Formally close an ended shift whose attendance is complete and current. */
export const POST = defineRoute({
  authorize: ({ params }) => schedulingBoardRouteAuthority(params, "manage"),
  feature: "hrmShiftClosing",
  params: z.object({ boardId: uuidString(), entryId: uuidString() }),
  body: z.strictObject({
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2000),
  }),
  handler: async ({ authz, params, body }) => {
    await closeShift({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      boardId: params.boardId,
      entryId: params.entryId,
      ...body,
    });
    return NextResponse.json({ closed: true });
  },
});
