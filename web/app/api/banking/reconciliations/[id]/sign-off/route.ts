import { NextResponse } from 'next/server'
import { markReconciled } from '@openbooks/engine/src/banking.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'
import { bankingErrorResponse } from '../../../util'

export const runtime = 'nodejs'

/** Sign off a zero-difference session: stamps matched journal lines reconciled. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    const result = await markReconciled(id, { orgId: user.orgId, userId: user.id })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return bankingErrorResponse(e)
  }
}
