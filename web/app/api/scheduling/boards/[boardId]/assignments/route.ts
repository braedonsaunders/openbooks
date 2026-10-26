import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { schedulingBoardRouteAuthority } from "@/lib/scheduling/board-route-authority";
import {
  createAssignment,
  listBoardAssignments,
  listBoardPatterns,
} from "@openbooks/engine/schedule-boards/pattern-store";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The board's recurring assignments and the patterns that can be assigned. */
export const GET = defineRoute({
  authorize: ({ params }) => schedulingBoardRouteAuthority(params, "read"),
  feature: { none: "The addressed board is gated and authorized by its native family and type." },
  params: z.object({ boardId: uuidString() }),
  handler: async ({ authz, params }) => {
    const actor = { orgId: authz.user.orgId, actorId: authz.user.id, boardId: params.boardId };
    const [assignments, patterns] = await Promise.all([
      listBoardAssignments(actor),
      listBoardPatterns(actor),
    ]);
    return NextResponse.json({ assignments, patterns });
  },
});

/** Assign a pattern to a person and generate its first horizon of bookings. */
export const POST = defineRoute({
  authorize: ({ params }) => schedulingBoardRouteAuthority(params, "manage"),
  feature: { none: "The addressed board is gated and authorized by its native family and type." },
  params: z.object({ boardId: uuidString() }),
  body: z.strictObject({
    id: uuidString(),
    patternId: uuidString(),
    workerPartyId: uuidString(),
    employmentId: uuidString().nullable().optional(),
    effectiveFrom: date,
    effectiveTo: date.nullable(),
    reason: z.string().trim().min(1).max(2000),
  }),
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await createAssignment({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        boardId: params.boardId,
        ...body,
      }),
    ),
});
