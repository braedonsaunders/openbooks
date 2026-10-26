import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { schedulingBoardRouteAuthority } from "@/lib/scheduling/board-route-authority";
import { defineRoute } from "@/lib/api/route";
import { publishScheduleBoard } from "@openbooks/engine/schedule-boards/publications";
import { deliverScheduleNotices } from "@/lib/scheduling/notify";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Publish a board's unpublished changes for a date range, all or nothing. Every
 * publication records the submitted revisions and its tenant Flow policy.
 */
export const POST = defineRoute({
  authorize: ({ params }) => schedulingBoardRouteAuthority(params, "manage"),
  feature: { none: "The addressed board is gated and authorized by its native family." },
  params: z.object({ boardId: uuidString() }),
  body: z.strictObject({
    from: date,
    through: date,
    reason: z.string().max(2000).nullable().optional(),
  }),
  handler: async ({ authz, params, body }) => {
    const result = await publishScheduleBoard({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      boardId: params.boardId,
      from: body.from,
      through: body.through,
      reason: body.reason ?? null,
    });
    const delivery = await deliverScheduleNotices({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      boardName: result.boardName,
      notices: result.notices,
    });
    return NextResponse.json({
      published: result.published,
      pending: result.pending,
      publicationId: result.publicationId,
      delivery,
      distributionRefusals: result.distributionRefusals,
    });
  },
});
