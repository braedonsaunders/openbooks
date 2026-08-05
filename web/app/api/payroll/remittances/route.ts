import { NextResponse } from 'next/server'
import { createRemittanceBill, payrollRemittanceSummary } from '@openbooks/engine/src/payroll-remittance.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'

export const dynamic = 'force-dynamic'

const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Payroll remittances — accrued withholding by destination for a period
 * (GET), and one-click materialization of a destination's vendor bill (POST
 * { action: 'create-bill', partyId, from, to }). The bill is a normal draft
 * vendor_bill debiting the liability accounts; AP review/post/pay finishes
 * the job.
 */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const url = new URL(req.url)
  const from = url.searchParams.get('from') ?? ''
  const to = url.searchParams.get('to') ?? ''
  if (!DATE.test(from) || !DATE.test(to) || from > to) {
    return NextResponse.json({ error: 'invalid period' }, { status: 422 })
  }
  const groups = await payrollRemittanceSummary(gate.user.orgId, { from, to })
  return NextResponse.json({ groups })
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const body = await req.json().catch(() => ({}))
  if (body.action !== 'create-bill') return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  const { partyId, from, to } = body
  if (!isUuid(partyId) || !DATE.test(String(from)) || !DATE.test(String(to))) {
    return NextResponse.json({ error: 'invalid request' }, { status: 422 })
  }
  try {
    const bill = await createRemittanceBill(gate.user.orgId, gate.user.id, { partyId, from, to })
    return NextResponse.json({ ok: true, ...bill })
  } catch (e) {
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
