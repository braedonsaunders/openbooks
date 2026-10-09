import { z } from 'zod'
import { NextResponse } from 'next/server'
import { schedulePdfLayoutSchema } from '@openbooks/forms-core'
import { previewScheduleBoardReport, downloadScheduleBoardReport } from '@openbooks/engine/src/schedule-boards/board-report.ts'
import { defineRoute } from '@/lib/api/route'
import { schedulingBoardRouteAuthority } from '@/lib/scheduling/board-route-authority'
const windowFields = {from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), layout: schedulePdfLayoutSchema.optional()}
export const POST = defineRoute({
  authorize: ({params}) => schedulingBoardRouteAuthority(params, 'manage'),
  feature: {none: 'Native board report services enforce scheduling features, operator authority and legal entity scope.'},
  params: z.object({boardId: z.string().uuid()}),
  body: z.discriminatedUnion('command', [
    z.strictObject({command: z.literal('preview'), ...windowFields}),
    z.strictObject({command: z.literal('pdf'), ...windowFields, layout: schedulePdfLayoutSchema, version: z.string().regex(/^[a-f0-9]{64}$/)}),
  ]),
  handler: async ({authz, params, body}) => {
    const actor = {orgId: authz.user.orgId, actorId: authz.user.id}
    if (body.command === 'preview') return NextResponse.json(await previewScheduleBoardReport(actor, {...body, boardId: params.boardId}))
    const bytes = await downloadScheduleBoardReport(actor, {...body, boardId: params.boardId})
    return new NextResponse(new Uint8Array(bytes), {headers: {'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="Schedule.pdf"', 'Cache-Control': 'no-store'}})
  },
})
