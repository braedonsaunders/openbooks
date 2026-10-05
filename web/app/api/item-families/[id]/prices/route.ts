import { NextResponse } from 'next/server'
import { z } from 'zod'
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

const familyParams = z.object({ id: z.string() })

function actorOf(gate: {
  user: { orgId: string; id: string }
  allowedSubsidiaryIds: ReadonlySet<string> | null
}) {
  return {
    orgId: gate.user.orgId,
    actorId: gate.user.id,
    allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
  }
}

/**
 * Price schedules owned by a product family. Same scopes, effective dating,
 * revisioning and quantity breaks as item schedules, through the one shared
 * schedule store — the subject is the only difference. Reads and writes
 * refuse when the itemVariants gate is off (data is kept); the store holds
 * the authoritative feature inside every write transaction.
 */
export const GET = defineRoute({
  permission: 'items.read',
  feature: 'itemVariants',
  params: familyParams,
  handler: async ({ authz: gate, params: { id } }) => {
    const data = await getSchedules(actorOf(gate), { kind: 'family', id })
    if (!data) return notFound('record')
    return NextResponse.json(data)
  },
})

export const POST = defineRoute({
  permission: 'items.manage',
  feature: 'itemVariants',
  scope: 'unrestricted',
  params: familyParams,
  body: priceScheduleBody,
  handler: async ({ request, authz: gate, params: { id }, body }) => {
    return postSchedule(request, actorOf(gate), { kind: 'family', id }, body)
  },
})

export const PATCH = defineRoute({
  permission: 'items.manage',
  feature: 'itemVariants',
  scope: 'unrestricted',
  params: familyParams,
  handler: async ({ request, authz: gate, params: { id } }) => {
    return patchSchedule(request, actorOf(gate), { kind: 'family', id })
  },
})

export const DELETE = defineRoute({
  permission: 'items.manage',
  feature: 'itemVariants',
  scope: 'unrestricted',
  params: familyParams,
  handler: async ({ request, authz: gate, params: { id } }) => {
    return deleteSchedule(request, actorOf(gate), { kind: 'family', id })
  },
})
