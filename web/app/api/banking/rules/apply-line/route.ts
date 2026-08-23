import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { PostingError } from '@openbooks/engine/src/posting.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { applyRuleToLine } from '../../../../../lib/banking-rules'
import { bankingErrorResponse } from '../../util'

export const runtime = 'nodejs'

/** Apply one rule to one unmatched line — confirming a suggested categorization. */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    statementLineId?: string
    ruleId?: string
    reconciliationId?: string
  }
  if (!body.statementLineId || !isUuid(body.statementLineId)) {
    return NextResponse.json({ error: 'statementLineId is required' }, { status: 400 })
  }
  if (!body.ruleId || !isUuid(body.ruleId)) {
    return NextResponse.json({ error: 'ruleId is required' }, { status: 400 })
  }
  try {
    await applyRuleToLine(user.orgId, user.id, {
      statementLineId: body.statementLineId,
      ruleId: body.ruleId,
      reconciliationId: body.reconciliationId && isUuid(body.reconciliationId) ? body.reconciliationId : undefined,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof PostingError) return NextResponse.json({ error: e.message }, { status: 422 })
    return bankingErrorResponse(e)
  }
}
