import { z } from 'zod'
import { NextResponse } from 'next/server'
import { schedulingBoardRouteAuthority } from '@/lib/scheduling/board-route-authority'
import { defineRoute } from '@/lib/api/route'
import { listProjectTaskOptions } from '@openbooks/engine/src/schedule-boards/targets.ts'

/** Open tasks of a project, for booking a person onto a specific task. */
export const GET = defineRoute({
  authorize: ({ params }) => schedulingBoardRouteAuthority(params, 'read'),
  feature: { none: 'The addressed board is gated and authorized by its native family.' },
  params: z.object({ boardId: z.string().uuid() }),
  handler: async ({ request, authz, params }) => {
    const projectId = new URL(request.url).searchParams.get('projectId') ?? ''
    const tasks = await listProjectTaskOptions({ orgId: authz.user.orgId, actorId: authz.user.id, boardId: params.boardId, projectId })
    return NextResponse.json({ tasks })
  },
})
