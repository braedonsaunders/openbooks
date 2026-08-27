import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { createRemittanceBill, payrollRemittanceSummary } from '@openbooks/engine/src/payroll-remittance.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import type { Authz } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import {
  guardPayrollEmployees,
  guardPayrollFilingAccounts,
  guardPayrollVendor,
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
  const groups = await payrollRemittanceSummary(gate.user.orgId, { from, to })
  return NextResponse.json({ groups })
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
      partyId, from, to, filingAccountId,
    })
    return NextResponse.json({ ok: true, ...bill })
  } catch (e) {
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}

/**
 * The remittance engine currently exposes an org-wide aggregate API. Before a
 * restricted caller reaches it, prove that every employee and filing account
 * contributing to that aggregate is visible. Denying the mixed aggregate is
 * fail-closed: returning it and filtering groups afterwards would still leak
 * gross/employee totals from a hidden subsidiary.
 */
async function guardRemittancePeriod(
  gate: Authz,
  from: string,
  to: string,
): Promise<Response | null> {
  if (gate.allowedSubsidiaryIds === null) return null
  const rows = (await db.execute<{ employeeId: string; filingAccountId: string | null }>(sql`
    select distinct s.employee_party_id as "employeeId",
           coalesce(prof.filing_account_id,
             (select fa.id from payroll_filing_accounts fa
               where fa.org_id = prof.org_id and fa.is_active and fa.is_default
                 and fa.country = coalesce(prof.country, 'CA') limit 1)) as "filingAccountId"
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
       and r.run_status = 'committed'
      left join employee_payroll_profiles prof
        on prof.org_id = s.org_id and prof.employee_party_id = s.employee_party_id
     where s.org_id = ${gate.user.orgId} and s.pay_date between ${from} and ${to}
  `)).rows
  const employeeDenied = await guardPayrollEmployees(gate, rows.map((row) => row.employeeId))
  if (employeeDenied) return employeeDenied
  const accountIds = rows.map((row) => row.filingAccountId).filter(Boolean)
  return accountIds.length ? guardPayrollFilingAccounts(gate, accountIds) : null
}
