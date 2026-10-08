import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { schedulingBoardRouteAuthority } from '@/lib/scheduling/board-route-authority'
import {
  previewScheduleDistribution,
  sendScheduleDistribution,
} from '@openbooks/engine/src/schedule-boards/distribution.ts'
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const audience = z.strictObject({
  visibility: z.enum(['personal', 'board']),
  everyone: z.boolean(),
  subjectIds: z.array(z.string().uuid()).max(500),
})
const selection = { from: date, through: date, audience }
export const POST = defineRoute({
  authorize: ({ params }) => schedulingBoardRouteAuthority(params, 'manage'),
  feature: {
    none: 'The native scheduling and Flows services enforce their authoritative feature and entity scope.',
  },
  params: z.object({ boardId: z.string().uuid() }),
  body: z.discriminatedUnion('command', [
    z.strictObject({ command: z.literal('preview'), ...selection }),
    z.strictObject({
      command: z.literal('send'),
      ...selection,
      version: z.string().regex(/^[a-f0-9]{64}$/),
      reason: z.string().trim().min(1).max(2000),
      key: z.string().uuid(),
    }),
  ]),
  handler: async ({ authz, params, body }) => {
    const actor = { orgId: authz.user.orgId, actorId: authz.user.id }
    return NextResponse.json(
      body.command === 'preview'
        ? await previewScheduleDistribution(
            actor,
            params.boardId,
            body.from,
            body.through,
            body.audience,
          )
        : await sendScheduleDistribution(actor, {
            boardId: params.boardId,
            ...body,
          }),
    )
  },
})
