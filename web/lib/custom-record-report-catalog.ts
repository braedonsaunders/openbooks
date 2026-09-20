import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { REPORT_ENTITY_MAP, bindPayStubIncomeTaxKeys, bindPayStubSocialKeys, customRecordEntities, validateCustomQuery, type ReportEntity, type ReportCustomQuery } from '@openbooks/reports'
import { eiColumnSystemKeys, employeeSocialInsuranceSystemKeys, incomeTaxWithholdingSystemKeys } from '@openbooks/engine/src/payroll/packs.ts'
import { can, type Authz } from './authz'
import { inTypeAudience } from './records'
import { lintRecordFields } from './record-schema'

/** Rebuilt per request/execution: no cross-tenant cache or stale role/definition grant. */
export async function customRecordReportCatalog(authz: Authz): Promise<Record<string, ReportEntity>> {
  if (!can(authz, 'records.read')) return {}
  const [definitions, assignments] = await Promise.all([
    db.execute<{ id: string; key: string; name: string; description: string | null; fields: unknown; allowed_roles: string[] | null }>(sql`
      select id,key,name,description,fields,allowed_roles from custom_record_types
      where org_id=${authz.user.orgId} and status='published' order by sort_order,name`),
    db.execute<{ key: string }>(sql`select r.key from role_assignments a
      join app_roles r on r.id=a.role_id and r.org_id=a.org_id
      where a.org_id=${authz.user.orgId} and a.user_id=${authz.user.id}`),
  ])
  const roles = assignments.rows.map(r => r.key)
  const entities = definitions.rows.flatMap(d => {
    if (!authz.user.isSuperAdmin && !inTypeAudience(roles, d.allowed_roles)) return []
    const fields = lintRecordFields(d.fields, d.name)
    return fields.success ? customRecordEntities({ ...d, fields: fields.sections }) : []
  })
  return Object.fromEntries(entities.map(e => [e.key, e]))
}

export async function reportEntityCatalog(authz: Authz): Promise<Record<string, ReportEntity>> {
  const catalog = { ...REPORT_ENTITY_MAP, ...await customRecordReportCatalog(authz) }
  // The register's income_tax column aggregates the pack-declared
  // withholding set (every deduction assessed on taxable income) from the
  // stub lines — never the CA/US factor labels baked into the static
  // catalog, which print 0.00 for every other pack. The cpp_fica and ei
  // columns aggregate the complementary pack-declared set (every deduction
  // assessed on earnings) the same way: `ei` counts the stated EI-family
  // pair, `cpp_fica` every other key by structural complement, so every
  // pack's contributions land in one of the two existing columns with both
  // labels untouched. The guard keeps a custom-record override of this key
  // (if one ever exists) untouched.
  const payStubs = catalog.pay_stubs
  if (payStubs?.key === 'pay_stubs') {
    catalog.pay_stubs = bindPayStubSocialKeys(
      bindPayStubIncomeTaxKeys(payStubs, incomeTaxWithholdingSystemKeys()),
      eiColumnSystemKeys(),
      employeeSocialInsuranceSystemKeys(),
    )
  }
  return catalog
}

export function validateCatalogReportQuery(query: unknown, catalog: Record<string, ReportEntity>) {
  const raw = query as ReportCustomQuery | null
  if (raw?.entity?.startsWith('custom:')) {
    const entity = Object.hasOwn(catalog, raw.entity) ? catalog[raw.entity] : null
    if (!entity) throw new Error('Custom record report source is unavailable')
    const fields = [...(raw.columns ?? []), ...(raw.breakouts ?? []).map(b => b.column),
      ...(raw.measures ?? []).flatMap(m => m.column ? [m.column] : []),
      ...(raw.sorts ?? []).map(s => s.column), ...(raw.groupBy ? [raw.groupBy] : [])]
    if (fields.some(f => !entity.columns.some(c => c.key === f))) throw new Error('A custom record report field changed or is unavailable; review the report definition')
  }
  return validateCustomQuery(query, catalog)
}

export async function validateOrgReportQuery(authz: Authz, query: unknown) {
  return validateCatalogReportQuery(query, await reportEntityCatalog(authz))
}
