import { NextResponse } from 'next/server'
import {
  comparisonFindings,
  parallelComparisons,
} from '@openbooks/engine/src/payroll-parallel-run-store.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const CLASSIFICATIONS = new Set([
  'match',
  'within_tolerance',
  'difference',
  'prior_only',
  'our_only',
  'employee_prior_only',
  'employee_our_only',
  'unattributed',
])

/**
 * One filed comparison and its findings — what the drawer drills into.
 *
 * The header always comes back with the findings, so a client cannot render a
 * list of cells without the population counts and the tolerance disclosure that
 * qualify them.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const [comparison] = await parallelComparisons(gate.user.orgId, {})
    .then((all) => all.filter((row) => row.id === id))
  if (!comparison) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const params = new URL(req.url).searchParams
  const employeePartyId = params.get('employeePartyId')
  const requested = params.getAll('classification').filter((value) => CLASSIFICATIONS.has(value))

  const findings = await comparisonFindings(gate.user.orgId, id, {
    employeePartyId: employeePartyId && isUuid(employeePartyId) ? employeePartyId : undefined,
    classifications: requested.length > 0 ? requested : undefined,
  })

  return NextResponse.json({ comparison, findings })
}
