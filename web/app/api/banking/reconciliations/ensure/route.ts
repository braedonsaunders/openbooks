import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { ensureOpenReconciliation } from '../../../../../lib/banking-rules'
import { bankingErrorResponse } from '../../util'

export const runtime = 'nodejs'

/** Find-or-create the open reconciliation for an account (Match Bank Data entry). */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const body = (await req.json().catch(() => ({}))) as { accountId?: string }
  if (!body.accountId || !isUuid(body.accountId)) {
    return NextResponse.json({ error: 'accountId is required' }, { status: 400 })
  }
  try {
    const id = await ensureOpenReconciliation(user.orgId, user.id, body.accountId)
    return NextResponse.json({ id })
  } catch (e) {
    return bankingErrorResponse(e)
  }
}
