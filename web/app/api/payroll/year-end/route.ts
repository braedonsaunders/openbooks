import { NextResponse } from 'next/server'
import { orgYearEndFilings } from '@openbooks/engine/src/payroll-yearend.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { payrollYearRefusal } from '../../../../lib/payroll-year'
import { guardPayrollYearEndFilings } from '../subsidiary-scope'

export const dynamic = 'force-dynamic'

/**
 * Year-end payroll artifacts for a tax year (?year=): every pack-declared
 * filing, populated from the committed-stub subledger — the same enumeration
 * the year-end page renders, so API consumers and the screen can never
 * disagree about what filings exist. Wage data — payroll.read only.
 */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const url = new URL(req.url)
  const yearRaw = url.searchParams.get('year')
  const yearRefusal = payrollYearRefusal(yearRaw)
  if (yearRefusal !== null) {
    return NextResponse.json({ error: yearRefusal }, { status: 422 })
  }
  const year = Number(yearRaw)
  const filings = await orgYearEndFilings(gate.user.orgId, year)
  const denied = await guardPayrollYearEndFilings(gate, filings, year)
  if (denied) return denied
  return NextResponse.json({
    filings: filings.map((filing) => ({
      country: filing.country,
      key: filing.key,
      label: filing.label,
      installed: filing.installed,
      data: filing.data,
      hasSlip: filing.hasSlip,
      populationRefusal: filing.populationRefusal,
      downloadRefusal: filing.downloadRefusal,
    })),
  })
}
