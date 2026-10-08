import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { schedulingBoardRouteAuthority } from '@/lib/scheduling/board-route-authority'
import { withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { updateSetupRecord } from '@/lib/setup/write'

export const PATCH = defineRoute({
  authorize: ({ params }) => schedulingBoardRouteAuthority(params, 'manage'),
  feature: {
    none: 'The addressed board owns its native feature and legal-entity guards.',
  },
  params: z.object({ boardId: z.string().uuid() }),
  body: z.strictObject({ showHoursColumn: z.boolean() }),
  handler: async ({ authz, params, body }) => {
    const result = await withOrgTransaction(authz.user.orgId, () =>
      updateSetupRecord(
        {
          orgId: authz.user.orgId,
          id: authz.user.id,
          permissions: authz.permissions,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        },
        'schedule-boards',
        { id: params.boardId, ...body },
      ),
    )
    return NextResponse.json(result.body, { status: result.status })
  },
})
