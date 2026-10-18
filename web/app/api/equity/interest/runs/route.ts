import { NextResponse } from 'next/server'
import { z } from 'zod'
import { postInterestRun } from '@openbooks/engine/equity'
import { defineRoute } from '@/lib/api/route'
import { isoDate, uuidId } from '@/lib/api/json'

export const runtime = 'nodejs'

const body = z.object({ subsidiaryId: uuidId, throughDate: isoDate() })

/**
 * Post the convertible note interest run through a date (an approval). A run
 * for a date already posted returns that run; nothing accrues twice.
 */
export const POST = defineRoute({
  permission: 'equity.approve',
  feature: 'equity',
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const run = await postInterestRun({ orgId: authz.user.orgId, actorId: authz.user.id, ...body })
    return NextResponse.json(run, { status: run.replayed ? 200 : 201 })
  },
})
