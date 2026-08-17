import 'server-only'
import { sql, type SQL } from 'drizzle-orm'

/**
 * Read-side of the gl_month_activity summary (maintained by the
 * openbooks_gl_activity_* journal triggers — see 0001_baseline.sql).
 *
 * Statements are date-range aggregations over posted+reversed entries. The
 * summary answers any month-aligned span from ~thousands of rows; a report
 * boundary that cuts a month in half makes that month a "split" month, whose
 * activity is read from the journal lines instead (bounded to at most a few
 * boundary months). The two sources union into one `buckets` relation:
 *
 *   b(account_id, subsidiary_id, d, amount, debit_total, credit_total)
 *
 * where summary rows carry d = first-of-month and line rows carry the actual
 * posting date. A column predicate `b.d between from and to` (or `<= to` for
 * balance mode) is exact for both kinds: a summary month whose start is
 * inside the column is fully inside it, because any month cut by a column
 * boundary is a split month and therefore not represented by a summary row.
 *
 * Amount math stays in Postgres numeric — nothing is summed in JS.
 */

export interface ActivityBoundary {
  date: string
  kind: 'start' | 'end'
}

const isMonthStart = (d: string) => d.slice(8, 10) === '01'

function monthStart(d: string): string {
  return `${d.slice(0, 7)}-01`
}

function nextMonthStart(d: string): string {
  const y = Number(d.slice(0, 4))
  const m = Number(d.slice(5, 7))
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

const isMonthEnd = (d: string) => {
  const next = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)) + 1))
  return next.getUTCDate() === 1
}

/**
 * The union relation described above. `minDate` null means inception
 * (balance-mode statements). Callers pass every column boundary; boundaries
 * that are already month-aligned split nothing.
 */
export function glActivityBuckets(
  orgId: string,
  opts: { minDate: string | null; maxDate: string; boundaries: ActivityBoundary[] },
): SQL {
  const split = new Set<string>()
  const consider = (b: ActivityBoundary) => {
    if (b.kind === 'start' ? !isMonthStart(b.date) : !isMonthEnd(b.date)) split.add(monthStart(b.date))
  }
  if (opts.minDate) consider({ date: opts.minDate, kind: 'start' })
  consider({ date: opts.maxDate, kind: 'end' })
  for (const b of opts.boundaries) consider(b)

  // Split months outside the overall window contribute nothing.
  const min = opts.minDate ? monthStart(opts.minDate) : null
  const max = monthStart(opts.maxDate)
  const splitMonths = [...split].filter((m) => (min === null || m >= min) && m <= max).sort()

  const summaryCaps = min === null ? sql`and g.month <= ${max}` : sql`and g.month >= ${min} and g.month <= ${max}`
  const splitFilter = splitMonths.length
    ? sql`and g.month <> all(${`{${splitMonths.join(',')}}`}::date[])`
    : sql``

  if (!splitMonths.length) {
    return sql`(
      select g.account_id, g.subsidiary_id, g.month as d,
             (g.debit_total - g.credit_total) as amount, g.debit_total, g.credit_total
        from gl_month_activity g
       where g.org_id = ${orgId} ${summaryCaps}
    )`
  }

  const ranges = sql.join(
    splitMonths.map((m) => sql`(e.posting_date >= ${m} and e.posting_date < ${nextMonthStart(m)})`),
    sql` or `,
  )
  return sql`(
    select g.account_id, g.subsidiary_id, g.month as d,
           (g.debit_total - g.credit_total) as amount, g.debit_total, g.credit_total
      from gl_month_activity g
     where g.org_id = ${orgId} ${summaryCaps} ${splitFilter}
    union all
    select l.account_id, l.subsidiary_id, e.posting_date as d,
           l.amount, greatest(l.amount, 0), greatest(-l.amount, 0)
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = ${orgId}
       and e.status in ('posted', 'reversed') and (${ranges})
     where l.org_id = ${orgId}
  )`
}

/**
 * True when a statement request is answerable from the summary: no line-level
 * dimension filters (a subsidiary filter is fine — the summary carries
 * subsidiary_id), accrual basis, and no per-line FX translation.
 */
export function glSummaryEligibleDims(dims?: {
  departmentId?: string
  projectId?: string
  locationId?: string
  classId?: string
  segments?: Record<string, string>
}): boolean {
  if (!dims) return true
  return (
    !dims.departmentId &&
    !dims.projectId &&
    !dims.locationId &&
    !dims.classId &&
    Object.keys(dims.segments ?? {}).length === 0
  )
}

/** Optional subsidiary scope applied to the buckets relation. */
export function bucketSubsidiaryFilter(subsidiaryIds?: string[]): SQL {
  return subsidiaryIds?.length
    ? sql`and b.subsidiary_id = any(${`{${subsidiaryIds.join(',')}}`}::uuid[])`
    : sql``
}
