import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { SETUP_ENTITY_BY_KEY, toSnake, type SetupEntity, type SetupRefSource } from './registry'
import { loadNumberSequenceKindOptions } from './number-sequence-kinds'

export type RefOption = { value: string; label: string }

/** Distinct ref sources declared anywhere in this entity's columns or fields. */
export function refSources(entity: SetupEntity): SetupRefSource[] {
  const set = new Set<SetupRefSource>()
  for (const c of entity.columns) if (c.ref) set.add(c.ref)
  for (const f of entity.fields) if (f.ref) set.add(f.ref)
  return [...set]
}

/** Postable accounts for the org, matching the company-settings pickers. */
export async function loadAccounts(orgId: string): Promise<RefOption[]> {
  const r = (await db.execute(sql`
    select id, number, name from accounts
     where org_id = ${orgId} and not is_summary and is_active
     order by number nulls last, name`)) as any
  return r.rows.map((a: any) => ({
    value: a.id as string,
    label: `${a.number ? `${a.number} · ` : ''}${a.name}`,
  }))
}

/** Options for a setup-entity ref source (id + code/name label). */
export async function loadEntityOptions(source: string, orgId: string): Promise<RefOption[]> {
  if (source === 'number-sequence-kinds') return loadNumberSequenceKindOptions(orgId)
  if (source === 'accounting-periods') {
    const periods = (await db.execute(sql`
      select id as value, name as label from accounting_periods
       where org_id = ${orgId} order by starts_on desc, period_number desc`)) as any
    return periods.rows as RefOption[]
  }
  if (source === 'items') {
    const items = (await db.execute(sql`
      select id as value,
             case when coalesce(code, '') <> '' then code || ' · ' || name else name end as label
        from items where org_id = ${orgId} and is_active order by code nulls last, name`)) as any
    return items.rows as RefOption[]
  }
  if (source === 'customers') {
    const customers = (await db.execute(sql`
      select p.id as value, p.display_name as label from parties p
       join customer_roles c on c.party_id = p.id and c.org_id = p.org_id and c.is_active
       where p.org_id = ${orgId} and p.is_active order by p.display_name`)) as any
    return customers.rows as RefOption[]
  }
  if (source === 'employees') {
    // Role-scoped view of the native parties model — never a parallel roster.
    const employees = (await db.execute(sql`
      select p.id as value, p.display_name as label from parties p
       join employee_roles e on e.party_id = p.id and e.org_id = p.org_id and e.is_active
       where p.org_id = ${orgId} and p.is_active order by p.display_name`)) as any
    return employees.rows as RefOption[]
  }
  if (source === 'equipment-units') {
    // The chargeable unit register. Like `trades`, a legitimate scope key with
    // no setup-registry entry of its own — equipment is managed under Assets.
    const units = (await db.execute(sql`
      select id as value, unit_number || ' · ' || name as label from equipment_units
       where org_id = ${orgId} and status = 'active' order by unit_number`)) as any
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
       order by lower(regexp_replace(trim(job_title), '\\s+', ' ', 'g')), trim(job_title)`)) as any
    return titles.rows as RefOption[]
  }
  if (source === 'trades') {
    // `trades` is a bare reference list with no setup-registry entry of its
    // own, but it is a legitimate scope key (labor_cost_rates uses it too).
    const trades = (await db.execute(sql`
      select id as value, name as label from trades
       where org_id = ${orgId} and is_active order by name`)) as any
    return trades.rows as RefOption[]
  }
  if (source === 'projects') {
    const projects = (await db.execute(sql`
      select id as value, case when coalesce(code,'') <> '' then code || ' · ' || name else name end as label
        from projects where org_id = ${orgId} and is_active order by code nulls last, name`)) as any
    return projects.rows as RefOption[]
  }
  const target = SETUP_ENTITY_BY_KEY.get(source)
  if (!target) return []
  const orgFilter = target.orgScoped ? sql` where org_id = ${orgId}` : sql``
  const customSegmentFilter = source === 'segment-definitions'
    ? (target.orgScoped ? sql` and source_kind = 'custom'` : sql` where source_kind = 'custom'`)
    : sql``
  // Label from whichever of `code`/`name` the entity actually carries:
  // subsidiaries are name-only, stock locations are code-only, most have both.
  const hasCode = target.fields.some((f) => f.key === 'code')
  const hasName = target.fields.some((f) => f.key === 'name')
  const labelExpr =
    hasCode && hasName
      ? sql.raw(`case when coalesce(code, '') <> '' then code || ' · ' || name else name end`)
      : hasCode
        ? sql.raw('code')
        : sql.raw('name')
  const orderCol = hasName ? 'name' : 'code'
  const r = (await db.execute(sql`
    select ${sql.raw(target.idColumn ?? 'id')} as value, ${labelExpr} as label
      from ${sql.raw(target.table)}${orgFilter}${customSegmentFilter}
     order by ${sql.raw(orderCol)}`)) as any
  return r.rows as RefOption[]
}

/** All ref-source option lists an entity's fields/columns need, keyed by source. */
export async function loadRefOptions(
  entity: SetupEntity,
  orgId: string,
): Promise<Record<string, RefOption[]>> {
  const out: Record<string, RefOption[]> = {}
  for (const source of refSources(entity)) {
    out[source] = source === 'accounts' ? await loadAccounts(orgId) : await loadEntityOptions(source, orgId)
  }
  return out
}

/** ORDER BY expression for an entity's list query. */
export function orderExpr(entity: SetupEntity): string {
  if (entity.orderBy) return entity.orderBy
  if (entity.naturalKey) return toSnake(entity.naturalKey)
  return entity.idColumn ?? 'id'
}
