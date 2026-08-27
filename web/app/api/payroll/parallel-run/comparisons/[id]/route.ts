import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  comparisonFindings,
  parallelComparisons,
} from '@openbooks/engine/src/payroll-parallel-run-store.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'
import { subsidiaryVisibleFilter } from '../../../../../../lib/subsidiaries'

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

  if (gate.allowedSubsidiaryIds !== null) {
    const ids = [...gate.allowedSubsidiaryIds]
    const comparison = (await db.execute<{
      id: string; registerId: string; payRunDocumentId: string
    }>(sql`
      select c.id, c.register_id as "registerId", c.pay_run_document_id as "payRunDocumentId"
        from payroll_parallel_comparisons c
       where c.org_id = ${gate.user.orgId} and c.id = ${id}`)).rows[0]
    if (!comparison) return NextResponse.json({ error: 'not found' }, { status: 404 })

    const registerOutside = ids.length
      ? sql`and (p.id is null or p.subsidiary_id is null
          or not (p.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[])))`
      : sql`and true`
    const register = (await db.execute<{ id: string }>(sql`
      select r.id
        from payroll_prior_registers r
       where r.org_id = ${gate.user.orgId} and r.id = ${comparison.registerId}
         and not exists (
           select 1
             from payroll_prior_stubs s
             left join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
            where s.org_id = r.org_id and s.register_id = r.id ${registerOutside})`)).rows[0]
    if (!register) return NextResponse.json({ error: 'not found' }, { status: 404 })

    const run = (await db.execute<{ id: string }>(sql`
      select r.document_id as id
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${gate.user.orgId} and r.document_id = ${comparison.payRunDocumentId}
         ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, gate.allowedSubsidiaryIds)}`)).rows[0]
    if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 })

    const findingOutside = (await db.execute<{ id: string }>(sql`
      select f.id
        from payroll_parallel_findings f
        left join parties p on p.id = f.employee_party_id and p.org_id = f.org_id
       where f.org_id = ${gate.user.orgId} and f.comparison_id = ${id}
         and (p.id is null or p.subsidiary_id is null
           or not (p.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[])))
       limit 1`)).rows[0]
    if (findingOutside) return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

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
