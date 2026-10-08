import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { featureEnabled, resolvedFeatureState } from '../features'
import { subsidiaryVisibleFilter } from '../subsidiaries'
import { SETUP_ENTITY_BY_KEY, refTargetPicker, toSnake, type SetupEntity, type SetupRefSource } from './registry'
import { loadNumberSequenceKindOptions } from './number-sequence-kinds'
import { setupReferenceSources } from './types'

export type RefOption = { value: string; label: string; scopeValue?: string | null; accountType?: string; minorUnits?: number }

/** Distinct ref sources declared anywhere in this entity's columns or fields. */
export function refSources(entity: SetupEntity): SetupRefSource[] {
  return setupReferenceSources(entity)
}

/** Postable accounts for the org, matching the company-settings pickers. */
export async function loadAccounts(orgId: string): Promise<RefOption[]> {
  const r = (await db.execute(sql`
    select id, number, name, type from accounts
     where org_id = ${orgId} and not is_summary and is_active
     order by number nulls last, name`))
  return r.rows.map((a) => ({
    value: a.id as string,
    label: `${a.number ? `${a.number} · ` : ''}${a.name}`,
    accountType: a.type as string,
  }))
}

/**
 * Active vendors for a remittance-party picker: active parties holding an
 * active vendor role. A NULL subsidiary is org-wide (visible to every scoped
 * caller), matching the payroll settings picker and the accounts-tab vendor
 * query — a subsidiary-scoped operator must still see the org-wide
 * statutory remittance vendors.
 */
export async function loadVendors(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Promise<RefOption[]> {
  const vendors = (await db.execute(sql`
    select p.id as value, p.display_name as label from parties p
     join vendor_roles v on v.party_id = p.id and v.org_id = p.org_id and v.is_active
     where p.org_id = ${orgId} and p.is_active
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
     order by p.display_name`))
  return vendors.rows as RefOption[]
}

/** Options for a setup-entity ref source (id + code/name label). */
export async function loadEntityOptions(
  source: string,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Promise<RefOption[]> {
  if (source === 'subsidiaries') {
    const employers = await db.execute<RefOption>(sql`select id::text as value,name as label from subsidiaries
      where org_id=${orgId} and is_active and not is_elimination
      ${subsidiaryVisibleFilter(sql`id`, allowedSubsidiaryIds)} order by name,id`)
    return employers.rows
  }
  if (source === 'compensation-currencies') {
    const { organizationCurrencyOptions } = await import('@openbooks/engine/organization/currencies')
    return organizationCurrencyOptions(db, orgId, allowedSubsidiaryIds)
  }
  if (source === 'benefit-currencies') {
    const { getAuthz } = await import('../authz')
    const { benefitCurrencyOptions } = await import('@openbooks/engine/hrm/benefits')
    const authz = await getAuthz()
    if (!authz || authz.user.orgId !== orgId) throw new Error('Benefit currency organization does not match the current session')
    return benefitCurrencyOptions(db, orgId, authz.user.id)
  }
  if (source === 'worker-employments') {
    const rows = await db.execute<RefOption>(sql`select e.id::text as value,
      p.display_name || ' · ' || s.name as label,e.employer_subsidiary_id::text as "scopeValue" from worker_employments e
      join parties p on p.org_id=e.org_id and p.id=e.worker_party_id
      join subsidiaries s on s.org_id=e.org_id and s.id=e.employer_subsidiary_id
      where e.org_id=${orgId} ${subsidiaryVisibleFilter(sql`e.employer_subsidiary_id`, allowedSubsidiaryIds)}
      order by p.display_name,e.id`)
    return rows.rows
  }
  if (source === 'approved-compensation-package-versions') {
    const rows = await db.execute<RefOption>(sql`select v.id::text as value,p.code || ' · ' || v.version::text || ' · ' || v.effective_from::text as label,
      p.id::text as "scopeValue" from payroll_compensation_versions v join payroll_compensation_packages p on p.org_id=v.org_id and p.id=v.package_id
      where v.org_id=${orgId} and v.status='approved' and p.status='active'
      ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)} order by p.code,v.version desc,v.id`)
    return rows.rows
  }
  if (source === 'payroll-compensation-packages') {
    const rows = await db.execute<RefOption>(sql`select id::text as value,code || ' · ' || name as label from payroll_compensation_packages
      where org_id=${orgId} ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds)} order by code,id`)
    return rows.rows
  }
  if (source === 'compensation-package-components') {
    const rows = await db.execute<RefOption>(sql`select id::text as value,code || ' · ' || name as label from pay_components
      where org_id=${orgId} and is_active and system_key is null and kind in ('earning','deduction','contribution') order by code,id`)
    return rows.rows
  }
  if (source === 'benefit-contribution-rules' || source === 'benefit-contribution-classes' || source === 'benefit-enrollment-rules' || source === 'benefit-recovery-deduction-rules' || source === 'benefit-recovery-premium-rules') {
    const classes = source === 'benefit-contribution-classes'
    const enrollmentScoped = source === 'benefit-enrollment-rules'
    const recoveryFilter = source === 'benefit-recovery-deduction-rules'
      ? sql`and c.kind='employee_deduction' and c.arrears_plan_id is not null`
      : source === 'benefit-recovery-premium-rules'
        ? sql`and c.kind in ('employer_contribution','taxable_non_cash') and c.basis in ('per_period','per_month','per_year') and c.rate_formula='elected_rate'` : sql``
    const rows = await db.execute<RefOption>(sql`select
      ${classes ? sql`c.class_key` : sql`c.id::text`} as value, c.name as label,
      ${enrollmentScoped ? sql`e.id::text` : sql`c.plan_id::text`} as "scopeValue"
      from ${sql.raw(classes ? 'hrm_benefit_contribution_classes' : 'hrm_benefit_contribution_rules')} c
      join hrm_benefit_plans p on p.org_id=c.org_id and p.id=c.plan_id
      ${enrollmentScoped ? sql`join hrm_benefit_enrollments e on e.org_id=c.org_id and e.plan_id=c.plan_id` : sql``}
      where c.org_id=${orgId} ${recoveryFilter} ${subsidiaryVisibleFilter(sql`p.employer_subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
      order by c.name,c.id`)
    return rows.rows
  }
  if (source === 'number-sequence-kinds') return loadNumberSequenceKindOptions(orgId)
  if (source === 'sales-channels') {
    // Storefront connections are module records, not setup entities — a bare
    // reference list like `trades`: the channel picker in map/location forms.
    const channels = (await db.execute(sql`
      select id as value, name as label from sales_channels
       where org_id = ${orgId} order by name`))
    return channels.rows as RefOption[]
  }
  // `vendors` names the parties+vendor_roles picker, not a registry entity:
  // without this branch the generic lookup below finds no entry and every
  // remittance-vendor listbox renders only None.
  if (source === 'vendors') return loadVendors(orgId, allowedSubsidiaryIds)
  if (source === 'currencies') {
    // Currency options carry their minor-unit precision so money fields can
    // convert between operator majors and storage minors exactly, from the
    // authoritative table rather than a client guess.
    const options = (await db.execute(sql`
      select code as value, name as label, minor_units as "minorUnits" from currencies order by code`))
    return options.rows as RefOption[]
  }
  if (source === 'accounting-periods') {
    const periods = (await db.execute(sql`
      select id as value, name as label from accounting_periods
       where org_id = ${orgId} order by starts_on desc, period_number desc`))
    return periods.rows as RefOption[]
  }
  if (source === 'items') {
    const items = (await db.execute(sql`
      select id as value,
             case when coalesce(code, '') <> '' then code || ' · ' || name else name end as label
        from items where org_id = ${orgId} and is_active order by code nulls last, name`))
    return items.rows as RefOption[]
  }
  if (source === 'customers') {
    const customers = (await db.execute(sql`
      select p.id as value, p.display_name as label from parties p
       join customer_roles c on c.party_id = p.id and c.org_id = p.org_id and c.is_active
       where p.org_id = ${orgId} and p.is_active order by p.display_name`))
    return customers.rows as RefOption[]
  }
  if (source === 'schedule-contacts') {
    return (await db.execute(sql`select id as value,display_name as label from parties where org_id=${orgId} and kind='person' and is_active ${subsidiaryVisibleFilter(sql`subsidiary_id`,allowedSubsidiaryIds)} order by display_name,id`)).rows as RefOption[]
  }
  if (source === 'employees') {
    // Role-scoped view of the native parties model — never a parallel roster.
    const employees = (await db.execute(sql`
      select p.id as value, p.display_name as label from parties p
       join employee_roles e on e.party_id = p.id and e.org_id = p.org_id and e.is_active
       where p.org_id = ${orgId} and p.is_active order by p.display_name`))
    return employees.rows as RefOption[]
  }
  if (source === 'pdf-templates') {
    // Active quote templates for the order-form picker. The PDF template
    // designer owns these rows; Setup only references them.
    const templates = (await db.execute(sql`
      select id as value, name as label from pdf_templates
       where org_id = ${orgId} and is_active and record_type = 'quote'
       order by is_default desc, name`))
    return templates.rows as RefOption[]
  }
  if (source === 'equipment-units') {
    // The chargeable unit register. Like `trades`, a legitimate scope key with
    // no setup-registry entry of its own — equipment is managed under Assets.
    const units = (await db.execute(sql`
      select id as value, unit_number || ' · ' || name as label from equipment_units
       where org_id = ${orgId} and status = 'active'
         ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds)}
       order by unit_number`))
    return units.rows as RefOption[]
  }
  if (source === 'job-titles') {
    // Distinct free-text job titles from the active employee roster — the
    // type-ahead corpus for `stringArray` title filters. Rule matching is
    // case- and whitespace-insensitive, so offer ONE representative per
    // normalized title (first by dictionary order) instead of every spelling.
    const titles = (await db.execute(sql`
      select distinct on (lower(regexp_replace(trim(job_title), '\\s+', ' ', 'g')))
             trim(job_title) as value, trim(job_title) as label
        from employee_roles
       where org_id = ${orgId} and is_active and coalesce(trim(job_title), '') <> ''
       order by lower(regexp_replace(trim(job_title), '\\s+', ' ', 'g')), trim(job_title)`))
    return titles.rows as RefOption[]
  }
  if (source === 'trades') {
    // `trades` is a bare reference list with no setup-registry entry of its
    // own, but it is a legitimate scope key (labor_cost_rates uses it too).
    const trades = (await db.execute(sql`
      select id as value, name as label from trades
       where org_id = ${orgId} and is_active order by name`))
    return trades.rows as RefOption[]
  }
  if (source === 'projects') {
    const projects = (await db.execute(sql`
      select id as value, case when coalesce(code,'') <> '' then code || ' · ' || name else name end as label
        from projects where org_id = ${orgId} and is_active order by code nulls last, name`))
    return projects.rows as RefOption[]
  }
  if (source === 'funds') {
    // The org's fund segment values — never the generic setup tables, which
    // cannot carry a fund classification. While Fund Accounting is off the
    // picker offers nothing: the owning setup pages 404 behind the same
    // switch, so an option here could never be saved anywhere honest.
    if (!featureEnabled(await resolvedFeatureState(orgId), 'fundAccounting')) return []
    const funds = (await db.execute(sql`
      select sv.id as value,
             case when coalesce(sv.code, '') <> '' then sv.code || ' · ' || sv.name else sv.name end as label
        from segment_values sv
        join segment_definitions sd on sd.org_id = sv.org_id and sd.id = sv.segment_id
       where sv.org_id = ${orgId} and sd.key = 'fund' and sd.source_kind = 'custom'
         and sv.is_active
       order by sv.code nulls last, sv.name`))
    return funds.rows as RefOption[]
  }
  const target = SETUP_ENTITY_BY_KEY.get(source)
  if (!target) return []
  const orgFilter = target.orgScoped ? sql` where org_id = ${orgId}` : sql``
  const customSegmentFilter = source === 'segment-definitions'
    ? (target.orgScoped ? sql` and source_kind = 'custom'` : sql` where source_kind = 'custom'`)
    : sql``
  // Label and order columns from the target's own declaration
  // (refTargetPicker in ./registry.ts) — never hardcoded code/name the
  // target may not carry. The option value is the refValue column (the
  // natural key) when referencing rows store it instead of the row id.
  const { valueCol, labelCols, orderCol } = refTargetPicker(target)
  const labelExpr =
    labelCols.length === 2
      ? sql.raw(
          `case when coalesce(${labelCols[0]}, '') <> '' then ${labelCols[0]} || ' · ' || ${labelCols[1]} else ${labelCols[1]} end`,
        )
      : sql.raw(labelCols[0]!)
  const r = (await db.execute(sql`
    select ${sql.raw(valueCol)} as value, ${labelExpr} as label
      from ${sql.raw(target.table)}${orgFilter}${customSegmentFilter}
     order by ${sql.raw(orderCol)}`))
  return r.rows as RefOption[]
}

/** All ref-source option lists an entity's fields/columns need, keyed by source. */
export async function loadRefOptions(
  entity: SetupEntity,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Promise<Record<string, RefOption[]>> {
  const out: Record<string, RefOption[]> = {}
  for (const source of refSources(entity)) {
    out[source] = source === 'accounts'
      ? await loadAccounts(orgId)
      : await loadEntityOptions(source, orgId, allowedSubsidiaryIds)
  }
  return out
}

/** ORDER BY expression for an entity's list query. */
export function orderExpr(entity: SetupEntity): string {
  if (entity.orderBy) return entity.orderBy
  if (entity.naturalKey) return toSnake(entity.naturalKey)
  return entity.idColumn ?? 'id'
}
