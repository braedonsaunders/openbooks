import 'server-only'
import { sql, type SQL } from 'drizzle-orm'

/**
 * Read-side of the gl_month_activity summary (maintained by the
 * openbooks_gl_activity_* journal triggers — see 0001_baseline.sql and
 * 0016_gl_month_activity_book_id.sql).
 *
 * Every read is scoped to exactly ONE accounting book: journal entries carry a
 * mandatory book_id and the summary keys it, so an unscoped read would fuse
 * parallel books (primary + tax + IFRS…) into one silently double-counted
 * total. Callers pass an explicit book; when none is given the org's primary
 * book is substituted in-query, so a forgotten filter degrades to "primary
 * book only", never to merged books.
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
 * The book a statement reads, as an inline SQL value expression: the caller's
 * explicit book when given, otherwise the org's primary book resolved
 * in-query (never "all books"). An org without any primary book yields NULL,
 * which matches no rows — an empty statement instead of a merged one.
 */
export function statementBookExpr(orgId: string | SQL, bookId?: string | null): SQL {
  return bookId
    ? sql`${bookId}::uuid`
    : sql`(select b.id from accounting_books b where b.org_id = ${orgId} and b.is_primary order by b.created_at limit 1)`
}

/**
 * The union relation described above. `minDate` null means inception
 * (balance-mode statements). Callers pass every column boundary; boundaries
 * that are already month-aligned split nothing. `bookId` scopes both legs to
 * one accounting book (primary when omitted — see statementBookExpr).
 */
export function glActivityBuckets(
  orgId: string,
  opts: { minDate: string | null; maxDate: string; boundaries: ActivityBoundary[]; bookId?: string | null },
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
  const book = sql`and g.book_id = ${statementBookExpr(orgId, opts.bookId)}`

  if (!splitMonths.length) {
    return sql`(
      select g.account_id, g.subsidiary_id, g.month as d,
             (g.debit_total - g.credit_total) as amount, g.debit_total, g.credit_total
        from gl_month_activity g
       where g.org_id = ${orgId} ${book} ${summaryCaps}
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
     where g.org_id = ${orgId} ${book} ${summaryCaps} ${splitFilter}
    union all
    select l.account_id, l.subsidiary_id, e.posting_date as d,
           l.amount, greatest(l.amount, 0), greatest(-l.amount, 0)
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = ${orgId}
       and e.status in ('posted', 'reversed') and (${ranges})
       and e.book_id = ${statementBookExpr(orgId, opts.bookId)}
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

/**
 * Per-account net movement for an as-of balance, from the summary.
 *
 * `fromExpr` is null for inception-to-date (balance-sheet accounts) or a
 * month-aligned SQL date for P&L accounts (a fiscal-year start is always the
 * first of a month). Because only the as-of date can fall mid-month, exactly
 * one month is ever split: everything strictly before the as-of month comes
 * from the summary, and the as-of month itself is read from the lines.
 *
 * Correlate it to a row (`orgExpr` = `a.org_id`) or pin it to a literal org.
 */
export function glAccountMovement(opts: {
  orgExpr: SQL
  accountIds: SQL
  asOf: SQL
  fromExpr?: SQL | null
  /** Explicit book scope; the org's primary book when omitted. */
  bookId?: string | null
}): SQL {
  const { orgExpr, accountIds, asOf, fromExpr } = opts
  const lowerSummary = fromExpr ? sql`and g.month >= date_trunc('month', ${fromExpr})::date` : sql``
  const lowerLines = fromExpr ? sql`and e.posting_date >= ${fromExpr}` : sql``
  const book = statementBookExpr(orgExpr, opts.bookId)
  return sql`(
    select coalesce(sum(x.amt), 0) as amount from (
      select (g.debit_total - g.credit_total) as amt
        from gl_month_activity g
       where g.org_id = ${orgExpr} and g.account_id in ${accountIds}
         and g.book_id = ${book}
         and g.month < date_trunc('month', ${asOf})::date ${lowerSummary}
      union all
      select l.amount
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = ${orgExpr}
         and e.status in ('posted', 'reversed')
         and e.book_id = ${book}
         and e.posting_date >= date_trunc('month', ${asOf})::date
         and e.posting_date <= ${asOf} ${lowerLines}
       where l.org_id = ${orgExpr} and l.account_id in ${accountIds}
    ) x
  )`
}

/** Optional subsidiary scope applied to the buckets relation. */
export function bucketSubsidiaryFilter(subsidiaryIds?: string[]): SQL {
  if (subsidiaryIds === undefined) return sql``
  return subsidiaryIds.length
    ? sql`and b.subsidiary_id = any(${`{${subsidiaryIds.join(',')}}`}::uuid[])`
    : sql`and false`
}
