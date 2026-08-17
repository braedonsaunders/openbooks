import { NextResponse } from 'next/server'
import { orgYearEndFilings } from '@openbooks/engine/src/payroll-yearend.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'

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
  const year = Number(url.searchParams.get('year'))
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return NextResponse.json({ error: 'invalid year' }, { status: 422 })
  }
  const filings = await orgYearEndFilings(gate.user.orgId, year)
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
