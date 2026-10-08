import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { searchTargets } from '@openbooks/engine/src/schedule-boards/targets.ts'

/** Booking targets matching what the scheduler typed: codes, customers, projects and locations. */
export const GET = defineRoute({
  permission: 'hrm.shifts.read',
  feature: 'hrmShiftPlanning',
  params: z.object({ boardId: z.string().uuid() }),
  handler: async ({ request, authz, params }) => {
    const url = new URL(request.url)
    const limit = Number(url.searchParams.get('limit') ?? '12')
    const targets = await searchTargets({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      boardId: params.boardId,
      query: url.searchParams.get('q') ?? '',
      limit: Number.isInteger(limit) ? limit : 12,
    })
    return NextResponse.json({ targets })
  },
})
