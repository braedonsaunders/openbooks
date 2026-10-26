import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { schedulingBoardRouteAuthority } from "@/lib/scheduling/board-route-authority";
import { listBoardShiftRequests } from "@openbooks/engine/schedule-boards/requests";

/** Shift requests on a board; open requests unless all are asked for. */
export const GET = defineRoute({
  authorize: ({ params }) => schedulingBoardRouteAuthority(params, "read"),
  feature: { none: "The addressed board is gated and authorized by its native family and type." },
  params: z.object({ boardId: uuidString() }),
  handler: async ({ request, authz, params }) => {
    const status = new URL(request.url).searchParams.get("status") === "all" ? "all" : "open";
    return NextResponse.json({
      requests: await listBoardShiftRequests({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        boardId: params.boardId,
        status,
      }),
    });
  },
});
