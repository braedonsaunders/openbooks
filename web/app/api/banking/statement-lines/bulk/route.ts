import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { excludePossibleDuplicates } from '@openbooks/engine/src/banking/banking.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { bankingErrorResponse } from '../../util'

export const runtime = 'nodejs'

/**
 * Bulk review of flagged lines: { action: 'exclude-duplicates', accountId, reason }.
 * Excludes every flagged unmatched line on the account as duplicates of
 * their earlier imports — the reviewer's answer to a re-exported file, so
 * it is not one click per line. One audited row per line.
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { action?: string; accountId?: string; reason?: string }
  if (body.action !== 'exclude-duplicates' || !isUuid(String(body.accountId ?? ''))) {
    return NextResponse.json({ error: 'action must be "exclude-duplicates" with an accountId' }, { status: 400 })
  }
  try {
    const result = await excludePossibleDuplicates(
      String(body.accountId),
      String(body.reason ?? ''),
      { orgId: user.orgId, userId: user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
    )
    return NextResponse.json({ ok: true, excluded: result.excluded })
  } catch (e) {
    return bankingErrorResponse(e)
  }
}
