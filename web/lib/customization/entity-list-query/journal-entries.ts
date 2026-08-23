import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";

/* ------------------------------------------------------------------ */
/* Journal entries                                                     */
/* ------------------------------------------------------------------ */

export const JOURNAL_ENTRY_BUILT_IN_EXPR: Record<string, SQL> = {
  posting_date: sql`e.posting_date`,
  entry_number: sql`e.entry_number`,
  memo: sql`e.memo`,
  origin: sql`e.origin`,
  line_count: sql`entry_totals.line_count`,
  total_debits: sql`entry_totals.total_debits`,
  status: sql`e.status`,
}

export const JOURNAL_ENTRY_SORTS: Record<string, SQL> = {
  date: sql`e.posting_date`,
  number: sql`e.entry_number`,
  origin: sql`e.origin`,
  lines: sql`entry_totals.line_count`,
  debits: sql`entry_totals.total_debits`,
  status: sql`e.status`,
}

/**
 * The journal list's backing relation: entries visible in the journal are the
 * union of (a) standalone engine journals by origin and (b) entries posted by
 * a journal-kind document. Both legs are index-driven ((org_id, origin,
 * posting_date) and documents (org_id, kind) → posted_entry_id); the outer
 * org_id predicate pushes down into each. UNION (not ALL) dedupes an entry
 * that qualifies both ways.
 */
export const JOURNAL_ENTRY_TABLE = `(
  select je.* from journal_entries je
   where je.origin in ('manual','closing','allocation','revaluation','labor_burden','depreciation','revenue_recognition','fx_settlement','translation')
  union
  select je.* from journal_entries je
    join documents jd on jd.posted_entry_id = je.id and jd.kind = 'journal' and jd.org_id = je.org_id
)`

/** The one join the journal-entry WHERE clause references (manual-vs-document
 * visibility). Count queries use exactly this — the per-entry line totals
 * below would otherwise be computed for EVERY entry in the tenant just to
 * produce a count. */
export function journalEntryCountJoins(): SQL {
  return sql`
    left join lateral (
      select d.id, d.custom
        from documents d
       where d.posted_entry_id = e.id and d.kind = 'journal'
       limit 1
    ) source_doc on true`
}

export function journalEntryBaseJoins(allowedSubsidiaryIds?: Set<string> | null): SQL {
  const ids = allowedSubsidiaryIds ? [...allowedSubsidiaryIds] : []
  const lineVisibility = allowedSubsidiaryIds
    ? ids.length
      ? sql`and l.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[])`
      : sql`and false`
    : sql``
  return sql`
    ${journalEntryCountJoins()}
    join lateral (
      select count(l.id) as line_count,
             coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0) as total_debits
        from journal_lines l
       where l.entry_id = e.id and l.org_id = e.org_id ${lineVisibility}
    ) entry_totals on true`
}

function journalEntryFilterPredicate(clause: FilterClause): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  const select = (column: SQL) => {
    if (clause.operator === 'eq') return sql`${column} = ${value}`
    if (clause.operator === 'ne') return sql`${column} <> ${value}`
    if (clause.operator === 'in' || clause.operator === 'not_in') {
      const values = (Array.isArray(clause.value) ? clause.value : [value]).map(String).filter(Boolean)
      if (!values.length) return clause.operator === 'in' ? sql`false` : sql`true`
      const list = sql.join(values.map((item) => sql`${item}`), sql`, `)
      return clause.operator === 'in' ? sql`${column} in (${list})` : sql`${column} not in (${list})`
    }
    return null
  }
  if (clause.key === 'origin') return select(sql`e.origin`)
  if (clause.key === 'status') return select(sql`e.status`)
  if (clause.key === 'posting_date') {
    if (clause.operator === 'eq') return sql`e.posting_date = ${value}`
    if (clause.operator === 'gte') return sql`e.posting_date >= ${value}`
    if (clause.operator === 'lte') return sql`e.posting_date <= ${value}`
    if (clause.operator === 'between') return sql`e.posting_date between ${value} and ${String(clause.to ?? '')}`
  }
  return null
}

export function journalEntryWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  // Visibility (journal-document entries plus standalone engine journals) is
  // built into JOURNAL_ENTRY_TABLE as a union of two index-driven legs — a
  // WHERE-level OR here defeated the ORDER BY/LIMIT index walk and the old
  // per-row source_doc lateral test ran for every entry in the tenant.
  const parts: SQL[] = [sql`e.org_id = ${orgId}`]
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and exists (
      select 1 from journal_lines visible
       where visible.entry_id=e.id and visible.org_id = e.org_id and visible.org_id = ${orgId}
         and visible.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[])
    )` : sql`and false`)
  }
  for (const filter of view.filters) {
    const predicate = journalEntryFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.origin) parts.push(sql`and e.origin = ${adhoc.filters.origin}`)
  if (adhoc.filters?.status) parts.push(sql`and e.status = ${adhoc.filters.status}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (e.entry_number ilike ${query} or e.memo ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}
