import { z } from 'zod'
import { NextResponse } from 'next/server'
import { schedulingBoardRouteAuthority } from '@/lib/scheduling/board-route-authority'
import { defineRoute } from '@/lib/api/route'
import { publishBoard } from '@openbooks/engine/src/schedule-boards/entries.ts'
import { deliverScheduleNotices } from '@/lib/scheduling/notify'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** Publish a staged board's unpublished changes for a date range, all or nothing. */
export const POST = defineRoute({
  authorize: ({ params }) => schedulingBoardRouteAuthority(params, 'publish'),
  feature: { none: 'The addressed board is gated and authorized by its native family.' },
  params: z.object({ boardId: z.string().uuid() }),
  body: z.strictObject({ from: date, through: date, reason: z.string().max(2000).nullable().optional() }),
  handler: async ({ authz, params, body }) => {
    const result = await publishBoard({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      boardId: params.boardId,
      from: body.from,
      through: body.through,
      reason: body.reason ?? null,
    })
    const delivery = await deliverScheduleNotices({ orgId: authz.user.orgId, actorId: authz.user.id, boardName: result.boardName, notices: result.notices })
    return NextResponse.json({ published: result.published, delivery, distributionRefusals: result.distributionRefusals })
  },
})
