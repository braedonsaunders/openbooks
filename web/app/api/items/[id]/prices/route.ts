import { NextResponse } from 'next/server'
import { guardPermission } from '@/lib/authz'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import {
  deleteSchedule,
  getSchedules,
  patchSchedule,
  postSchedule,
  priceScheduleBody,
} from '../../../_pricing/schedule-store'

export const runtime = 'nodejs'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('items.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const data = await getSchedules(
    { orgId: gate.user.orgId, actorId: gate.user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
    { kind: 'item', id },
  )
  if (!data) return notFound('record')
  return NextResponse.json(data)
}

export const POST = defineRoute({
  permission: 'items.manage',
  feature: { none: 'Item price schedules are catalog data governed by items.manage; no feature key gates them.' },
  body: priceScheduleBody,
  handler: async ({ request, authz, params, body }) => {
    const gate = authz
    const { id } = (await params) as { id: string }
    return postSchedule(
      request,
      { orgId: gate.user.orgId, actorId: gate.user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
      { kind: 'item', id },
      body,
    )
  },
})

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('items.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  return patchSchedule(
    request,
    { orgId: gate.user.orgId, actorId: gate.user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
    { kind: 'item', id },
  )
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('items.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  return deleteSchedule(
    request,
    { orgId: gate.user.orgId, actorId: gate.user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
    { kind: 'item', id },
  )
}
