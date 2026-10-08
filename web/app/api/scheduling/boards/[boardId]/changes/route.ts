import { z } from 'zod'
import { NextResponse } from 'next/server'
import { schedulingBoardRouteAuthority } from '@/lib/scheduling/board-route-authority'
import { defineRoute } from '@/lib/api/route'
import { applyBoardChanges, type BoardChange } from '@openbooks/engine/src/schedule-boards/entries.ts'
import { deliverScheduleNotices } from '@/lib/scheduling/notify'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const clock = z.string().regex(/^\d{2}:\d{2}$/)
const span = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('day') }),
  z.strictObject({ mode: z.literal('timed'), starts: clock, ends: clock, breakMinutes: z.number().int().min(0).max(240) }),
])
const target = z.strictObject({ kind: z.enum(['customer', 'project', 'location', 'code']), id: z.string().uuid() }).nullable()
const fields = {
  workerPartyId: z.string().uuid().optional(),
  subject: z.strictObject({ kind: z.enum(['person', 'equipment', 'location']), id: z.string().uuid() }).optional(),
  onDate: date,
  target,
  projectTaskId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  detail: z.string().max(120).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  span,
  seriesId: z.string().uuid().nullable().optional(),
}
const change = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('create'), id: z.string().uuid(), ...fields }).refine((value) => Boolean(value.workerPartyId) !== Boolean(value.subject), 'Choose exactly one booking subject'),
  z.strictObject({
    op: z.literal('update'),
    id: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    fields: z.strictObject({
      workerPartyId: fields.workerPartyId,
      subject: fields.subject,
      onDate: date.optional(),
      target: target.optional(),
      projectTaskId: fields.projectTaskId,
      departmentId: fields.departmentId,
      detail: fields.detail,
      notes: fields.notes,
      span: span.optional(),
      seriesId: fields.seriesId,
    }).refine((value) => Object.keys(value).length > 0, 'Name at least one field to change')
      .refine((value) => !(value.workerPartyId && value.subject), 'Choose exactly one booking subject'),
  }),
  z.strictObject({ op: z.literal('cancel'), id: z.string().uuid(), expectedRevision: z.number().int().positive() }),
])
const body = z.strictObject({
  changes: z.array(change).min(1).max(500),
  reason: z.string().max(2000).nullable().optional(),
})

/** Book, change and remove people on a board. Each change reports its own result. */
export const POST = defineRoute({
  authorize: ({ params }) => schedulingBoardRouteAuthority(params, 'manage'),
  feature: { none: 'The addressed board is gated and authorized by its native family.' },
  params: z.object({ boardId: z.string().uuid() }),
  body,
  handler: async ({ authz, params, body }) => {
    const result = await applyBoardChanges({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      boardId: params.boardId,
      changes: body.changes as BoardChange[],
      reason: body.reason ?? null,
    })
    // Delivery follows the committed command and never changes its outcome.
    const delivery = await deliverScheduleNotices({ orgId: authz.user.orgId, actorId: authz.user.id, boardName: result.boardName, notices: result.notices })
    return NextResponse.json({ results: result.results, delivery, distributionRefusals:result.distributionRefusals })
  },
})
