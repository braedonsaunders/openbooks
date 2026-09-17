import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";
import { dateOrFalse } from "../list-query";

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
 * Origins posted as standalone GL-native journals with no subledger document:
 * every engine that writes its own journal_entries rows without a source
 * document must appear here or its journals vanish from the Journal list
 * (reports still tie — the entries exist — but the audit trail does not show
 * them). Entries posted from a subledger document (bills, invoices, payments,
 * pay runs, …) live in their own module and stay out. The Journal page count
 * consumes this same list; keep the two in sync by construction, not by copy.
 */
export const JOURNAL_GL_NATIVE_ORIGINS = [
  "manual",
  "closing",
  "allocation",
  "revaluation",
  "fx_revaluation",
  "labor_burden",
  "payroll_variance",
  "overhead_applied",
  "depreciation",
  "disposal",
  "revenue_recognition",
  "fx_settlement",
  "translation",
  "intercompany",
  "inventory",
  "lease",
  "tax_provision",
  // Migration true-ups (TRUEUP-*) are standalone engine journals with no
  // source document (F-t12-014): without this they post to the GL yet stay
  // invisible in the list and its counts even with Origin=All.
  "migration",
];

/**
 * The journal list's backing relation: entries visible in the journal are the
 * union of (a) standalone engine journals by origin and (b) entries posted by
 * a journal- or pay-run-kind document. Both legs are index-driven ((org_id,
 * origin, posting_date) and documents (org_id, kind) → posted_entry_id); the
 * outer org_id predicate pushes down into each. UNION (not ALL) dedupes an
 * entry that qualifies both ways. Pay runs ride leg (b): a posted payroll JE
 * hits the GL like any other posting and the run links to it, so hiding it
 * here breaks the audit trail (F-t08-014). Other subledger postings (bills,
 * invoices, payments, …) still live in their own modules and stay out. The
 * /journal header and the setup-guide "posted entries" tile count this same
 * relation through journalScopeWhere, so all three surfaces agree by
 * construction (F-t11-010).
 */
export const JOURNAL_ENTRY_TABLE = `(
  select je.* from journal_entries je
   where je.origin in (${JOURNAL_GL_NATIVE_ORIGINS.map((origin) => `'${origin}'`).join(",")})
  union
  select je.* from journal_entries je
    join documents jd on jd.posted_entry_id = je.id and jd.kind in ('journal', 'pay_run') and jd.org_id = je.org_id
)`

/** The one join the journal-entry WHERE clause references (manual-vs-document
 * visibility). Count queries use exactly this — the per-entry line totals
 * below would otherwise be computed for EVERY entry in the tenant just to
 * produce a count. */
/**
 * The one journal scope every "posted entries" surface counts (F-t11-010):
 * the setup-guide tile, the /journal header, and the list total all read
 * the JOURNAL_ENTRY_TABLE union through this predicate — org-wide, both
 * statuses, subsidiary-fenced exactly like the list. Reversed entries stay
 * in: the list shows them (status facet, destructive variant) and the
 * header describes that same page total, so a posted-only scope here would
 * re-split the header from the list it heads. journalEntryWhere builds on
 * this; the header and guide readers call it directly with no view filters
 * (the journal default view carries none), so the three counts agree by
 * construction instead of by copy. Alias `e` matches the list table alias.
 */
export function journalScopeWhere(orgId: string, allowedSubsidiaryIds?: Set<string> | null): SQL {
  const parts: SQL[] = [sql`e.org_id = ${orgId}`]
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and exists (
      select 1 from journal_lines visible
       where visible.entry_id=e.id and visible.org_id = e.org_id and visible.org_id = ${orgId}
         and visible.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[])
    )` : sql`and false`)
  }
  return sql.join(parts, sql` `)
}

export function journalEntryCountJoins(): SQL {
  return sql`
    left join lateral (
      select d.id, d.custom, d.kind
        from documents d
       where d.posted_entry_id = e.id and d.kind in ('journal', 'pay_run')
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
    const refusedDay = dateOrFalse(value)
    if (refusedDay) return refusedDay
    if (clause.operator === 'eq') return sql`e.posting_date = ${value}`
    if (clause.operator === 'gte') return sql`e.posting_date >= ${value}`
    if (clause.operator === 'lte') return sql`e.posting_date <= ${value}`
    if (clause.operator === 'between') {
      const refusedUpper = dateOrFalse(String(clause.to ?? ''))
      if (refusedUpper) return refusedUpper
      return sql`e.posting_date between ${value} and ${String(clause.to ?? '')}`
    }
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
  // Org scope plus the subsidiary fence is the shared journalScopeWhere so
  // the list total and the header/guide counts cannot drift apart (F-t11-010).
  const parts: SQL[] = [journalScopeWhere(orgId, allowedSubsidiaryIds)]
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
