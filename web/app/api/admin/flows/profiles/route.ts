import { NextResponse } from 'next/server'
import { listFlowSubjectProfiles } from '@openbooks/engine/src/flows/index.ts'
import { guardPermission } from '../../../../../lib/authz'

export const runtime = 'nodejs'

/**
 * Flow subject profiles — the builder vocabulary (triggers, actions,
 * statuses, fields, roles) per subject kind. Drives the New Flow picker and
 * every inspector select in the builder.
 */
export async function GET() {
  const gate = await guardPermission('flows.manage')
  if (gate instanceof NextResponse) return gate
  return NextResponse.json({ profiles: listFlowSubjectProfiles() })
}
