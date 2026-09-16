import { NextResponse } from 'next/server'
import { publishVersion } from '../../../../../../../../../engine/src/allocations/index.ts'
import { guardAllocations } from '../../../../../../../../lib/allocations-gate'
import { allocationErrorResponse, requireRuleId } from '../../../../../_lib.ts'

export const runtime = 'nodejs'

/**
 * Publish a draft version: A1 runs full validation (problems come back
 * inline as 422 with stable codes for the drawer), stamps the definition
 * hash, and points the rule's current version. Empty body.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const gate = await guardAllocations('allocations.manage')
  if (gate instanceof NextResponse) return gate
  const { id, versionId } = await params
  const ruleId = requireRuleId(id)
  if (ruleId instanceof NextResponse) return ruleId
  const versionParam = requireRuleId(versionId)
  if (versionParam instanceof NextResponse) return versionParam
  try {
    const published = await publishVersion(
      versionParam,
      { orgId: gate.user.orgId, actorId: gate.user.id },
    )
    if (published.version.ruleId !== ruleId) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    return NextResponse.json({
      version: { ...published.version, revision: published.revision },
      targets: published.targets,
    })
  } catch (error) {
    return allocationErrorResponse(error)
  }
}
