import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { getRuleDetail, updateRule } from '../../../../../../engine/src/allocations/index.ts'
import { guardAllocations } from '../../../../../lib/allocations-gate'
import { allocationErrorResponse, allocationWriteErrorResponse, requireRevision, requireRuleId } from '../../_lib.ts'

export const runtime = 'nodejs'

/** One rule head (identity/ordering) with its version timeline. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardAllocations('allocations.read')
  if (gate instanceof NextResponse) return gate
  const id = requireRuleId((await params).id)
  if (id instanceof NextResponse) return id
  try {
    return NextResponse.json(await getRuleDetail(gate.user.orgId, id))
  } catch (error) {
    return allocationErrorResponse(error)
  }
}

/** Update the head (name/description/order/active). `expectedRevision` is required. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardAllocations('allocations.manage')
  if (gate instanceof NextResponse) return gate
  const id = requireRuleId((await params).id)
  if (id instanceof NextResponse) return id
  const parsed = await parseJsonBody(req, jsonObject)
  if (!parsed.ok) return parsed.response
  const body = parsed.data as {
    name?: unknown
    description?: unknown
    sortOrder?: unknown
    isActive?: unknown
    expectedRevision?: unknown
  }
  const revision = requireRevision(body)
  if (revision instanceof NextResponse) return revision
  if (
    (body.name !== undefined && typeof body.name !== 'string')
    || (body.description !== undefined && body.description !== null && typeof body.description !== 'string')
    || (body.sortOrder !== undefined && typeof body.sortOrder !== 'number')
    || (body.isActive !== undefined && typeof body.isActive !== 'boolean')
  ) {
    return NextResponse.json({ error: 'Invalid rule head fields.' }, { status: 400 })
  }
  try {
    const updated = await updateRule(
      id,
      {
        orgId: gate.user.orgId,
        expectedRevision: revision,
        name: body.name as string | undefined,
        description: body.description as string | null | undefined,
        sortOrder: body.sortOrder as number | undefined,
        isActive: body.isActive as boolean | undefined,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      },
      { actorId: gate.user.id },
    )
    return NextResponse.json({ rule: { ...updated.rule, revision: updated.revision } })
  } catch (error) {
    return allocationWriteErrorResponse(error)
  }
}
