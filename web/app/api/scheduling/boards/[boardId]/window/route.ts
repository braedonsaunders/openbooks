import { z } from 'zod'
import { NextResponse } from 'next/server'
import { schedulingBoardRouteAuthority } from '@/lib/scheduling/board-route-authority'
import { defineRoute } from '@/lib/api/route'
import { loadBoardWindow } from '@openbooks/engine/src/schedule-boards/window.ts'

/** The people-board read model for a date window. */
export const GET = defineRoute({
  authorize: ({ params }) => schedulingBoardRouteAuthority(params, 'read'),
  feature: { none: 'The addressed board is gated and authorized by its native family.' },
  params: z.object({ boardId: z.string().uuid() }),
  handler: async ({ request, authz, params }) => {
    const url = new URL(request.url)
    const window = await loadBoardWindow({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      boardId: params.boardId,
      from: url.searchParams.get('from') ?? '',
      through: url.searchParams.get('through') ?? undefined,
    })
    return NextResponse.json(window)
  },
})
