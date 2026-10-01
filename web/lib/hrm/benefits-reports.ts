import 'server-only'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import { ensureReportDefinitions } from '@openbooks/engine/reports'
import { can, type Authz } from '../authz'
import { canRunReportEntity } from '../report-authz'

const BENEFITS_REPORTS = [
  { key: 'enrollments', slug: 'workforce-benefit-enrollments', entity: 'hrm_benefit_enrollments' },
  { key: 'inputs', slug: 'workforce-benefit-payroll-inputs', entity: 'hrm_benefit_payroll_inputs' },
  { key: 'awards', slug: 'workforce-benefit-awards', entity: 'hrm_benefit_awards' },
] as const

export type BenefitsReportLink = { key: (typeof BENEFITS_REPORTS)[number]['key']; href: string }

/** Resolve actual native report definitions. A tenant-owned slug collision
 * never turns an employer's custom report into a product-owned destination. */
export async function loadBenefitsReportLinks(authz: Authz): Promise<BenefitsReportLink[]> {
  if (!can(authz, 'reports.read')) return []
  const allowed = (await Promise.all(BENEFITS_REPORTS.map(async (report) =>
    await canRunReportEntity(authz, { entity: report.entity }) ? report : null,
  ))).filter((report) => report !== null)
  if (allowed.length === 0) return []
  return withOrgTransaction(authz.user.orgId, async () => {
    await ensureReportDefinitions(authz.user.orgId)
    const { rows } = await db.execute<{ id: string; slug: string; entity: string }>(sql`
      select id, slug, query->>'entity' as entity from report_definitions
       where org_id = ${authz.user.orgId} and kind = 'built_in'
         and coalesce(report_type, 'query') = 'query' and archived_at is null
         and slug in (${sql.join(allowed.map((report) => sql`${report.slug}`), sql`, `)})
    `)
    return allowed.flatMap((report) => {
      const definition = rows.find((row) => row.slug === report.slug && row.entity === report.entity)
      return definition ? [{ key: report.key, href: `/reports/custom/run/${definition.id}` }] : []
    })
  })
}
