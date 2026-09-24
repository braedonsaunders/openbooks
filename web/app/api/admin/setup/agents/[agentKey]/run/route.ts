import { NextResponse } from 'next/server'
import { UnrestrictedScopeError } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { guardFeaturePermission } from '../../../../../../../lib/feature-gates'
import { runSetupAgentNow } from '../../../../../../../lib/setup/agents'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/setup/agents/[agentKey]/run — manual scan from the Setup
 * area. Same `runContinuousCloseAgent` command as POST
 * /api/continuous-close/run, behind the setup gate instead of the provider
 * key; a disabled Continuous Close module 404s like every other hidden-module
 * API surface.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ agentKey: string }> }) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'continuousClose')
  if (gate instanceof NextResponse) return gate
  const { agentKey } = await params
  let result
  try {
    // A manual scan runs the org-wide detector pack and auto-resolves other
    // entities' unmatched findings, so subsidiary-restricted callers are
    // refused by name before the scan persists anything.
    result = await runSetupAgentNow(gate.user.orgId, gate.user.id, agentKey, gate.allowedSubsidiaryIds)
  } catch (error) {
    // A disable landing after the preflight refuses by name; only a genuinely
    // unknown key is an invalid agent. Collapsing both into invalid_agent
    // would tell the operator the pack does not exist when the switch is off.
    if ((error as Error).message === 'feature_disabled') {
      return NextResponse.json({ error: 'feature_disabled' }, { status: 409 })
    }
    if (error instanceof UnrestrictedScopeError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    return NextResponse.json({ error: 'invalid_agent' }, { status: 404 })
  }
  if (result.status === 'claimed_elsewhere') return NextResponse.json(result, { status: 409 })
  return NextResponse.json(result, {
    status: result.status === 'failed' ? 500 : result.status === 'skipped' ? 409 : 200,
  })
}
