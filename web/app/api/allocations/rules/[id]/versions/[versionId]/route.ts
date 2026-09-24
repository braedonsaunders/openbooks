import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { getRuleVersion, updateDraftVersion } from '../../../../../../../../engine/src/allocations/index.ts'
import { guardAllocations } from '../../../../../../../lib/allocations-gate'
import { allocationErrorResponse, allocationWriteErrorResponse, requireRevision, requireRuleId } from '../../../../_lib.ts'

export const runtime = 'nodejs'

/** Draft-editable version fields — everything outside A1's frozen set. */
const DRAFT_FIELDS = [
  'effectiveFrom',
  'effectiveTo',
  'bookScope',
  'bookIds',
  'documentKinds',
  'accountScope',
  'dimensionFilters',
  'applyPolicy',
  'sourceMeasure',
  'basisKind',
  'driverId',
  'driverAsOf',
  'basisConfig',
  'targetKind',
  'dynamicTarget',
  'impact',
  'offsetAccountId',
  'residualPolicy',
  'residualTargetId',
  'solveMethod',
  'runPolicy',
  'runOffsetDays',
  'approvalFlowId',
  'memoTemplate',
  'lineDescriptionTemplate',
] as const

/** One version with its explicit targets (Versions tab + drawer). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const gate = await guardAllocations('allocations.read')
  if (gate instanceof NextResponse) return gate
  const { id, versionId } = await params
  const ruleId = requireRuleId(id)
  if (ruleId instanceof NextResponse) return ruleId
  const versionParam = requireRuleId(versionId)
  if (versionParam instanceof NextResponse) return versionParam
  try {
    const found = await getRuleVersion(gate.user.orgId, versionParam)
    if (found.version.ruleId !== ruleId) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    return NextResponse.json(found)
  } catch (error) {
    return allocationErrorResponse(error)
  }
}

/** Edit a draft version. Only whitelisted definition fields; `expectedRevision` required. */
export async function PATCH(
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
  const body = parsed.data as Record<string, unknown> & { expectedRevision?: unknown }
  const revision = requireRevision(body)
  if (revision instanceof NextResponse) return revision
  const patch: Record<string, unknown> = {
    orgId: gate.user.orgId,
    expectedRevision: revision,
    allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
  }
  for (const key of DRAFT_FIELDS) {
    if (body[key] !== undefined) patch[key] = body[key]
  }
  try {
    const current = await getRuleVersion(gate.user.orgId, versionParam)
    if (current.version.ruleId !== ruleId) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    const updated = await updateDraftVersion(
      versionParam,
      patch as Parameters<typeof updateDraftVersion>[1],
      { actorId: gate.user.id },
    )
    return NextResponse.json({ version: { ...updated.version, revision: updated.revision } })
  } catch (error) {
    return allocationWriteErrorResponse(error)
  }
}
