import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { ControlAccountsIncompleteError } from '@openbooks/engine/src/control-accounts.ts'
import { PostingError } from '@openbooks/engine/src/posting.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'
import { addJournalMatchFromLine } from '../../../../../../lib/banking-rules'
import { bankingErrorResponse } from '../../../util'

export const runtime = 'nodejs'

/** Add a journal from an unmatched bank line and match it: { reconciliationId, offsetAccountId }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { reconciliationId?: string; offsetAccountId?: string }
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
    // Unconfigured org control accounts refuse the match before any GL write.
    if (e instanceof ControlAccountsIncompleteError) {
      return NextResponse.json({ error: e.message }, { status: 422 })
    }
    return bankingErrorResponse(e)
  }
}
