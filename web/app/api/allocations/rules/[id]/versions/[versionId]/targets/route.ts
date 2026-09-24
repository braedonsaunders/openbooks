import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import {
  getRuleVersion,
  replaceTargets,
  type AllocationTargetInput,
} from '../../../../../../../../../engine/src/allocations/index.ts'
import { guardAllocations } from '../../../../../../../../lib/allocations-gate'
import { allocationWriteErrorResponse, requireRevision, requireRuleId } from '../../../../../_lib.ts'

export const runtime = 'nodejs'

const TARGET_FIELDS = [
  'targetAccountId',
  'departmentId',
  'locationId',
  'classId',
  'projectId',
  'subsidiaryId',
  'extraDims',
  'fixedPercent',
  'weight',
  'isRemainder',
  'label',
] as const

function toTargetInput(raw: unknown): AllocationTargetInput | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const picked: Record<string, unknown> = {}
  for (const field of TARGET_FIELDS) {
    if (source[field] !== undefined) picked[field] = source[field]
  }
  return picked as AllocationTargetInput
}

/** Replace a draft version's explicit targets (ordered by array position). */
export async function PUT(
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
  const body = parsed.data as { targets?: unknown; expectedRevision?: unknown }
  const revision = requireRevision(body)
  if (revision instanceof NextResponse) return revision
  if (!Array.isArray(body.targets)) {
    return NextResponse.json({ error: 'Targets must be an array.' }, { status: 400 })
  }
  const targets: AllocationTargetInput[] = []
  for (const raw of body.targets) {
    const target = toTargetInput(raw)
    if (!target) return NextResponse.json({ error: 'Each target must be an object.' }, { status: 400 })
    targets.push(target)
  }
  try {
    const current = await getRuleVersion(gate.user.orgId, versionParam, gate.allowedSubsidiaryIds)
    if (current.version.ruleId !== ruleId) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    const saved = await replaceTargets(
      versionParam,
      { orgId: gate.user.orgId, expectedRevision: revision, targets, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
      { actorId: gate.user.id },
    )
    return NextResponse.json({ targets: saved.targets, revision: saved.revision })
  } catch (error) {
    return allocationWriteErrorResponse(error)
  }
}
