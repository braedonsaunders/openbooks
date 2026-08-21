import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { amendTimeEntry } from '../../../../lib/time-amendment'

export const runtime = 'nodejs'

/**
 * POST { entryId } → create an offsetting draft entry that amends a consumed
 * original. Used when reopen is refused because the hours are already
 * invoiced, paid, costed or ticketed.
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('time.reopen', 'timeTracking')
  if (gate instanceof NextResponse) return gate
  const body = (await req.json()) as { entryId?: string }
  if (!body.entryId || !isUuid(body.entryId)) {
    return NextResponse.json({ error: 'Invalid entry' }, { status: 422 })
  }
  try {
    const result = await amendTimeEntry(gate.user.orgId, gate.user.id, body.entryId)
    return NextResponse.json(result, { status: 201 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'could not amend' }, { status: 422 })
  }
}
