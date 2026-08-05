import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { previewRules } from '../../../../../lib/banking-rules'
import { validateCriteria, validateOutcome } from '../../../../../lib/banking-rules-validate'
import { bankingErrorResponse } from '../../util'

export const runtime = 'nodejs'

/**
 * Dry-run rules against an account's recent bank lines without touching the
 * ledger. With `criteria`/`outcome`, previews a single draft rule (the builder's
 * live preview); without them, previews all active rules (rule-health / the
 * suggest surface). Never posts.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('banking.reconcile')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  if (!body.accountId || !isUuid(String(body.accountId))) {
    return NextResponse.json({ error: 'accountId is required' }, { status: 400 })
  }
  const accountId = String(body.accountId)
  const windowDays = Number(body.windowDays) > 0 ? Math.min(Number(body.windowDays), 730) : 90
  const onlyUnmatched = body.onlyUnmatched === true
  const limit = Number(body.limit) > 0 ? Math.min(Number(body.limit), 200) : 25

  let draftRule: NonNullable<Parameters<typeof previewRules>[2]>['draftRule']
  if (body.criteria !== undefined || body.outcome !== undefined) {
    const c = validateCriteria(body.criteria)
    if (!c.ok) return NextResponse.json({ error: c.error }, { status: 400 })
    const o = validateOutcome(body.outcome ?? { action: 'exclude' })
    if (!o.ok) return NextResponse.json({ error: o.error }, { status: 400 })
    draftRule = {
      criteria: c.value,
      outcome: o.value,
      priority: Number(body.priority) || 100,
      id: isUuid(String(body.id)) ? String(body.id) : undefined,
    }
  }

  try {
    const result = await previewRules(user.orgId, accountId, { draftRule, windowDays, onlyUnmatched, limit })
    return NextResponse.json(result)
  } catch (e) {
    return bankingErrorResponse(e)
  }
}
