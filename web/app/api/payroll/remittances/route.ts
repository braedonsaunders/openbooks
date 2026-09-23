import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { createRemittanceBill, payrollRemittanceSummary } from '@openbooks/engine/src/payroll/remittance.ts'
import { PayrollError } from "@openbooks/engine/src/payroll/error.ts";
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { suppliedValue } from '../../../../lib/payroll-decimal-refusal'
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
 * to, subsidiaryId? }). A group spanning several legal entities splits into
 * one bill per entity; pass the slice's subsidiaryId to bill exactly that
 * entity's share. The bill is a normal draft vendor_bill debiting the
 * liability accounts; AP review/post/pay finishes the job.
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
  // Shape alone admits impossible dates ('2026-02-30', month 13) that the
  // summary would otherwise hand to PostgreSQL as a driver error: refuse by
  // name before any row is read.
  if (!isIsoCalendarDate(from) || !isIsoCalendarDate(to)) {
    return NextResponse.json({ error: `invalid period "${from}" – "${to}": pass real YYYY-MM-DD calendar dates` }, { status: 422 })
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
  const subsidiaryId = body.subsidiaryId ?? null
  // Every malformed shape refuses by name: one collapsed 'invalid request'
  // over eight predicates across five fields. Same accept/refuse sets, split
  // causes — every input refused above is still refused below with status 422.
  if (typeof partyId !== 'string') {
    return NextResponse.json({ error: `partyId must be a vendor id — got "${suppliedValue(partyId)}"; choose the payee from the remittance summary` }, { status: 422 })
  }
  if (!isUuid(partyId)) {
    return NextResponse.json({ error: `partyId "${partyId}" is not a vendor id — choose the payee from the remittance summary` }, { status: 422 })
  }
  if (typeof from !== 'string' || !DATE.test(from)) {
    return NextResponse.json({ error: `from must be a date "YYYY-MM-DD" — got "${suppliedValue(from)}"; pass the period start as a date` }, { status: 422 })
  }
  if (typeof to !== 'string' || !DATE.test(to)) {
    return NextResponse.json({ error: `to must be a date "YYYY-MM-DD" — got "${suppliedValue(to)}"; pass the period end as a date` }, { status: 422 })
  }
  // Shape alone admits impossible dates ('2026-02-30', month 13) that the
  // engine would otherwise hand to PostgreSQL as a driver error: refuse each
  // by name before the bill path reads a row.
  if (!isIsoCalendarDate(from)) {
    return NextResponse.json({ error: `from "${from}" is not a real calendar date — pass the period start as a date that exists` }, { status: 422 })
  }
  if (!isIsoCalendarDate(to)) {
    return NextResponse.json({ error: `to "${to}" is not a real calendar date — pass the period end as a date that exists` }, { status: 422 })
  }
  if (from > to) {
    return NextResponse.json({ error: `from "${from}" is after to "${to}" — the period must start on or before it ends` }, { status: 422 })
  }
  if (filingAccountId !== null && (typeof filingAccountId !== 'string' || !isUuid(filingAccountId))) {
    return NextResponse.json({ error: `filingAccountId "${suppliedValue(filingAccountId)}" is not a filing account id — choose one from the payroll filing accounts, or omit it` }, { status: 422 })
  }
  if (subsidiaryId !== null && (typeof subsidiaryId !== 'string' || !isUuid(subsidiaryId))) {
    return NextResponse.json({ error: `subsidiaryId "${suppliedValue(subsidiaryId)}" is not a subsidiary id — pass the subsidiary whose share to bill, or omit it` }, { status: 422 })
  }
  const vendorDenied = await guardPayrollVendor(gate, partyId)
  if (vendorDenied) return vendorDenied
  const accountDenied = await guardPayrollFilingAccounts(gate, [filingAccountId])
  if (accountDenied) return accountDenied
  const periodDenied = await guardRemittancePeriod(gate, String(from), String(to))
  if (periodDenied) return periodDenied
  try {
    const bill = await createRemittanceBill(gate.user.orgId, gate.user.id, {
      partyId, from, to, filingAccountId, subsidiaryId, allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    })
    return NextResponse.json({ ok: true, ...bill })
  } catch (e) {
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
