import {schedulePdfLayoutSchema} from '@openbooks/forms-core'
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { schedulingBoardRouteAuthority } from '@/lib/scheduling/board-route-authority'
import {
  previewScheduleDistribution,serializeSchedulePreview,
  sendScheduleDistribution,
  searchScheduleContacts,previewSchedulePdf,
} from '@openbooks/engine/src/schedule-boards/distribution.ts'
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const audience = z.strictObject({
  visibility: z.enum(['personal', 'board']),
  recipientMode:z.enum(['automatic','selected','combined']).optional(),
  everyone: z.boolean(),
  subjectIds: z.array(z.string().uuid()).max(500),
  cohort:z.enum(['scope','scheduled','supervisors','self']).optional(),
  additionalRoleKeys:z.array(z.string().min(1).max(80)).max(20).optional(),
  additionalPartyIds:z.array(z.string().uuid()).max(500).optional(),
  pdfLayout:schedulePdfLayoutSchema.nullable().optional(),
  includePdf:z.boolean().optional(),message:z.string().max(4000).optional(),
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
    z.strictObject({command:z.literal('pdf'),...selection,version:z.string().regex(/^[a-f0-9]{64}$/),partyId:z.string().uuid()}),
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
    if(body.command==='pdf'){const bytes=await previewSchedulePdf(actor,{boardId:params.boardId,...body});return new NextResponse(new Uint8Array(bytes),{headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="Schedule.pdf"','Cache-Control':'no-store'}})}
    const result=await (
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
          })
    )
    return NextResponse.json(body.command==='preview'?serializeSchedulePreview(result as Awaited<ReturnType<typeof previewScheduleDistribution>>):result)
  },
})

export const GET=defineRoute({authorize:({params})=>schedulingBoardRouteAuthority(params,'manage'),feature:{none:'Native addressed board authority governs contact visibility.'},params:z.object({boardId:z.string().uuid()}),handler:async({authz,params,request})=>{const query=new URL(request.url).searchParams.get('q')??'';if(query.length>120)return NextResponse.json({error:'Contact search is too long.'},{status:400});return NextResponse.json(await searchScheduleContacts({orgId:authz.user.orgId,actorId:authz.user.id},params.boardId,query));}})
