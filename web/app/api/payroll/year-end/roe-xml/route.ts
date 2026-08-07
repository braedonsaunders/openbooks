import { NextResponse } from 'next/server'
import { buildRoeXml, isRoeReasonCode, type RoeIssueInput } from '@openbooks/engine/src/payroll-roexml.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * GET ?employees=<partyId>:<reasonCode>[:<comment>],… — the Service Canada
 * ROE Web bulk-upload XML. Fails closed (422) naming missing SINs, missing
 * reason comments, and employees with no committed pay periods. Validate
 * against the ROE Web schema before transmitting.
 *
 * The reason for issue is an employer declaration, so it always arrives from
 * the request — never inferred from the payroll data.
 */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const raw = new URL(req.url).searchParams.get('employees') ?? ''
  const issues: RoeIssueInput[] = []
  for (const entry of raw.split(',').filter(Boolean)) {
    const [employeePartyId, reasonCode, ...comment] = entry.split(':')
    if (!isUuid(employeePartyId ?? '') || !isRoeReasonCode(reasonCode)) {
      return NextResponse.json({ error: 'invalid employee selection' }, { status: 422 })
    }
    const text = decodeURIComponent(comment.join(':')).trim()
    if (text.length > 500) return NextResponse.json({ error: 'comment too long' }, { status: 422 })
    issues.push({ employeePartyId: employeePartyId!, reasonCode, comment: text || null })
  }
  if (issues.length === 0 || issues.length > 500) {
    return NextResponse.json({ error: 'invalid employee selection' }, { status: 422 })
  }
  try {
    const file = await buildRoeXml(gate.user.orgId, issues)
    return new NextResponse(file.xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
      },
    })
  } catch (e) {
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
