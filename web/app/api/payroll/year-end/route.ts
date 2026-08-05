import { NextResponse } from 'next/server'
import {
  form941Worksheet, roeWorksheet, t4Slips, t4Summary, w2Slips,
} from '@openbooks/engine/src/payroll-yearend.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * Year-end payroll artifacts: T4 slips + Summary and the US 941/W-2
 * worksheets for a tax year (?year=), or one employee's ROE worksheet
 * (?year=&roe=<employeePartyId>). Wage data — payroll.read only.
 */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const url = new URL(req.url)
  const year = Number(url.searchParams.get('year'))
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return NextResponse.json({ error: 'invalid year' }, { status: 422 })
  }
  const roeEmployee = url.searchParams.get('roe')
  if (roeEmployee) {
    if (!isUuid(roeEmployee)) return NextResponse.json({ error: 'invalid employee' }, { status: 422 })
    const worksheet = await roeWorksheet(gate.user.orgId, roeEmployee)
    return NextResponse.json({ roe: worksheet })
  }
  const [slips, summary, form941, w2] = await Promise.all([
    t4Slips(gate.user.orgId, year),
    t4Summary(gate.user.orgId, year),
    form941Worksheet(gate.user.orgId, year),
    w2Slips(gate.user.orgId, year),
  ])
  return NextResponse.json({ t4: slips, t4Summary: summary, form941, w2 })
}
