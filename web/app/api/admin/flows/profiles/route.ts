import { NextResponse } from 'next/server'
import { listFlowSubjectProfiles } from '@openbooks/engine/src/flows/index.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'

export const runtime = 'nodejs'

/**
 * Flow subject profiles — the builder vocabulary (triggers, actions,
 * statuses, fields, roles) per subject kind. Drives the New Flow picker and
 * every inspector select in the builder.
 */
export async function GET() {
  const gate = await guardFeaturePermission('flows.manage', 'flows')
  if (gate instanceof NextResponse) return gate
  return NextResponse.json({ profiles: listFlowSubjectProfiles() })
}
