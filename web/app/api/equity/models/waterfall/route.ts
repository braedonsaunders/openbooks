import { NextResponse } from 'next/server'
import { z } from 'zod'
import { runEntityWaterfall } from '@openbooks/engine/equity'
import { defineRoute } from '@/lib/api/route'
import { isoDate, uuidId } from '@/lib/api/json'
import { decimalText } from '../../_schema'

export const runtime = 'nodejs'

const body = z.object({
  subsidiaryId: uuidId,
  asOf: isoDate(),
  exitValue: decimalText,
  unvestedAwards: z.enum(['participate', 'cancel']).default('participate'),
  changeOfControl: z.boolean().default(true),
  terminated: z.boolean().default(false),
})

/** Distribute an exit value through the preference stack to classes, holders and securities. Nothing is recorded. */
export const POST = defineRoute({
  permission: 'equity.read',
  feature: 'equity',
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => NextResponse.json(await runEntityWaterfall({ orgId: authz.user.orgId, actorId: authz.user.id, ...body })),
})
