import { NextResponse } from 'next/server'
import { autoMatch } from '@openbooks/engine/src/banking.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'
import { bankingErrorResponse } from '../../../util'

export const runtime = 'nodejs'

/** Exact amount + date ≤3d → 0.9, ≤14d → 0.7; each journal line used once. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    const result = await autoMatch(id, { orgId: user.orgId, userId: user.id })
    return NextResponse.json(result)
  } catch (e) {
    return bankingErrorResponse(e)
  }
}
