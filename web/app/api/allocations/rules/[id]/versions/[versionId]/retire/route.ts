import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { retireVersion } from '../../../../../../../../../engine/src/allocations/index.ts'
import { guardAllocations } from '../../../../../../../../lib/allocations-gate'
import { allocationWriteErrorResponse, requireRuleId } from '../../../../../_lib.ts'

export const runtime = 'nodejs'

/** Retire a published version. `{ reason }` is required (the drawer prompts). */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const gate = await guardAllocations('allocations.manage')
  if (gate instanceof NextResponse) return gate
  const { id, versionId } = await params
  const ruleId = requireRuleId(id)
  if (ruleId instanceof NextResponse) return ruleId
  const versionParam = requireRuleId(versionId)
  if (versionParam instanceof NextResponse) return versionParam
  const parsed = await parseJsonBody(req, jsonObject)
  if (!parsed.ok) return parsed.response
  const body = parsed.data as { reason?: unknown }
  if (typeof body.reason !== 'string' || body.reason.trim() === '') {
    return NextResponse.json({ error: 'A reason is required to retire a version.' }, { status: 422 })
  }
  try {
    const retired = await retireVersion(
      versionParam,
      { orgId: gate.user.orgId, expectedRuleId: ruleId, actorId: gate.user.id, reason: body.reason.trim(), allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
    )
    if (retired.version.ruleId !== ruleId) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    return NextResponse.json({ version: { ...retired.version, revision: retired.revision } })
  } catch (error) {
    return allocationWriteErrorResponse(error)
  }
}
