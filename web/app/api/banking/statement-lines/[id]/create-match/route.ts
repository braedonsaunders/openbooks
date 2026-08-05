import { NextResponse } from 'next/server'
import { PostingError } from '@openbooks/engine/src/posting.ts'
import { guardPermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { addJournalMatchFromLine } from '../../../../../../lib/banking-rules'
import { bankingErrorResponse } from '../../../util'

export const runtime = 'nodejs'

/** Add a journal from an unmatched bank line and match it: { reconciliationId, offsetAccountId }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('banking.reconcile')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as { reconciliationId?: string; offsetAccountId?: string }
  if (!body.reconciliationId || !isUuid(body.reconciliationId) || !body.offsetAccountId || !isUuid(body.offsetAccountId)) {
    return NextResponse.json({ error: 'reconciliationId and offsetAccountId are required' }, { status: 400 })
  }
  try {
    await addJournalMatchFromLine(user.orgId, user.id, {
      statementLineId: id,
      offsetAccountId: body.offsetAccountId,
      reconciliationId: body.reconciliationId,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof PostingError) return NextResponse.json({ error: e.message }, { status: 422 })
    return bankingErrorResponse(e)
  }
}
