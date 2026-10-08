import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { loadProjectProgress } from '@openbooks/engine/src/schedule-boards/progress.ts'

/** Production progress for one project on a task board. */
export const GET = defineRoute({
  permission: 'projects.read',
  feature: 'projectScheduling',
  params: z.object({ boardId: z.string().uuid() }),
  handler: async ({ request, authz, params }) => {
    const projectId = new URL(request.url).searchParams.get('projectId') ?? ''
    const progress = await loadProjectProgress({ orgId: authz.user.orgId, actorId: authz.user.id, boardId: params.boardId, projectId })
    return NextResponse.json(progress)
  },
})
