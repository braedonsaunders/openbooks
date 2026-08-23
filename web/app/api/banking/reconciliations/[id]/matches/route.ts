import { NextResponse } from 'next/server'
import { createMatch, unmatchStatementLine } from '@openbooks/engine/src/banking.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'
import { bankingErrorResponse } from '../../../util'

export const runtime = 'nodejs'

type Params = { params: Promise<{ id: string }> }

/** Manual match: one statement line ↔ one or more journal lines. */
export async function POST(req: Request, { params }: Params) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = (await req.json()) as { statementLineId?: string; journalLineIds?: string[] }
  if (
    !body.statementLineId ||
    !isUuid(body.statementLineId) ||
    !Array.isArray(body.journalLineIds) ||
    body.journalLineIds.length === 0 ||
    !body.journalLineIds.every((j) => typeof j === 'string' && isUuid(j))
  ) {
    return NextResponse.json(
      { error: 'statementLineId and at least one journalLineId are required' },
      { status: 400 },
    )
  }
  try {
    const totals = await createMatch(
      { reconciliationId: id, statementLineId: body.statementLineId, journalLineIds: body.journalLineIds },
      { orgId: user.orgId, userId: user.id },
    )
    return NextResponse.json({ ok: true, totals })
  } catch (e) {
    return bankingErrorResponse(e)
  }
}

/** Unmatch a statement line (removes all its pairs in this session): ?statementLineId= */
export async function DELETE(req: Request, { params }: Params) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  const statementLineId = new URL(req.url).searchParams.get('statementLineId')
  if (!isUuid(id) || !statementLineId || !isUuid(statementLineId)) {
    return NextResponse.json({ error: 'statementLineId required' }, { status: 400 })
  }
  try {
    const totals = await unmatchStatementLine(
      { reconciliationId: id, statementLineId },
      { orgId: user.orgId, userId: user.id },
    )
    return NextResponse.json({ ok: true, totals })
  } catch (e) {
    return bankingErrorResponse(e)
  }
}
