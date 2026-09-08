import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { createRemittanceBill, payrollRemittanceSummary } from '@openbooks/engine/src/payroll-remittance.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import {
  guardPayrollFilingAccounts,
  guardPayrollVendor,
  guardRemittancePeriod,
} from '../subsidiary-scope'

export const dynamic = 'force-dynamic'

const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Payroll remittances — accrued withholding by destination AND payroll filing
 * account for a period (GET), and one-click materialization of a group's
 * vendor bill (POST { action: 'create-bill', partyId, filingAccountId, from,
 * to }). The bill is a normal draft vendor_bill debiting the liability
 * accounts; AP review/post/pay finishes the job.
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
  const denied = await guardRemittancePeriod(gate, from, to)
  if (denied) return denied
  try {
    const groups = await payrollRemittanceSummary(gate.user.orgId, { from, to }, gate.allowedSubsidiaryIds)
    return NextResponse.json({ groups })
  } catch (error) {
    if (error instanceof PayrollError) return NextResponse.json({ error: error.message }, { status: 422 })
    throw error
  }
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  if (body.action !== 'create-bill') return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  const { partyId, from, to } = body
  const filingAccountId = body.filingAccountId ?? null
  if (
    !isUuid(partyId) || !DATE.test(String(from)) || !DATE.test(String(to))
    || from > to
    || (filingAccountId !== null && !isUuid(filingAccountId))
  ) {
    return NextResponse.json({ error: 'invalid request' }, { status: 422 })
  }
  const vendorDenied = await guardPayrollVendor(gate, partyId)
  if (vendorDenied) return vendorDenied
  const accountDenied = await guardPayrollFilingAccounts(gate, [filingAccountId])
  if (accountDenied) return accountDenied
  const periodDenied = await guardRemittancePeriod(gate, String(from), String(to))
  if (periodDenied) return periodDenied
  try {
    const bill = await createRemittanceBill(gate.user.orgId, gate.user.id, {
      partyId, from, to, filingAccountId, allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    })
    return NextResponse.json({ ok: true, ...bill })
  } catch (e) {
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
