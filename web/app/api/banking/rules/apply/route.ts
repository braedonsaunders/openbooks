import { NextResponse } from 'next/server'
import { PostingError } from '@openbooks/engine/src/posting.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { applyRulesToAccount } from '../../../../../lib/banking-rules'
import { bankingErrorResponse } from '../../util'

export const runtime = 'nodejs'

/** Run active reconciliation rules against an account's unmatched bank lines. */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const body = (await req.json().catch(() => ({}))) as { accountId?: string }
  if (!body.accountId || !isUuid(body.accountId)) {
    return NextResponse.json({ error: 'accountId is required' }, { status: 400 })
  }
  try {
    const result = await applyRulesToAccount(user.orgId, user.id, body.accountId)
    return NextResponse.json(result)
  } catch (e) {
    if (e instanceof PostingError) return NextResponse.json({ error: e.message }, { status: 422 })
    return bankingErrorResponse(e)
  }
}
