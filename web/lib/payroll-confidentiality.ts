import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import type { ReportEntity } from '@openbooks/reports'
// Permission check only — never './authz' here: that module pulls
// next/navigation, which breaks plain-node consumers of the ledger readers
// (spawned test children without the react-server condition).
import { permissionSetCovers } from './permissions'
import { decimalAdd, type ExactDecimal } from './statement-format'

/**
 * ONE consistent payroll-line confidentiality policy for every ledger reader.
 *
 * A user with `reports.read` (or `gl.read`) but WITHOUT `payroll.read` can
 * otherwise read every employee's name and net pay: payroll posts
 * per-employee party-tagged journal lines (the pay-run projection and the
 * net-pay settlement both tag the net-pay legs with the employee party), and
 * the journal, general ledger, account register, drills, entry flyout,
 * assistant/MCP ledger tools, and the ledger_lines report-builder entity all
 * join journal_lines to parties and print display_name + amount.
 *
 * The policy, applied at the shared data layer every reader goes through
 * (never per route):
 *
 * - Identify payroll-origin lines reliably: the entry's source document is a
 *   pay run (`documents.kind = 'pay_run'` — true for the run projection, the
 *   net-pay settlement, and their reversals, which all keep
 *   source_document_id), or the entry itself carries origin 'payroll' (the
 *   direct settlement insert, covering any row whose document link is ever
 *   absent).
 * - For a reader WITHOUT payroll.read, party-tagged payroll lines keep their
 *   ACCOUNT and AMOUNT — aggregates and totals still balance — but collapse
 *   into ONE restricted line per journal entry per account, with the employee
 *   identity and per-employee memo replaced by the label below. A reports-only
 *   reader sees no employee names and no per-employee amounts; a payroll.read
 *   reader sees full detail.
 * - Non-party payroll lines (the bank leg, aggregate wage/tax legs) carry no
 *   per-employee detail and pass through untouched.
 */

export const PAYROLL_RESTRICTED_PARTY_LABEL = 'Payroll (restricted)'

/** True when this reader may see per-employee payroll detail. */
export function canSeePayrollDetail(authz: { permissions: Set<string> } | null | undefined): boolean {
  return !!authz && permissionSetCovers(authz.permissions, 'payroll.read')
}

/**
 * SQL predicate matching payroll-origin journal lines. `docKind` is the
 * entry's source-document kind expression (documents.kind, may be null);
 * `entryOrigin` is the journal_entries.origin expression. Either signal is
 * sufficient: run postings carry the pay_run document link (even when their
 * origin flips to 'intercompany'), while the settlement insert stamps origin
 * 'payroll' directly.
 */
export function payrollOriginSql(docKind: SQL, entryOrigin?: SQL): SQL {
  return entryOrigin === undefined
    ? sql`(${docKind} = 'pay_run')`
    : sql`(${docKind} = 'pay_run' or ${entryOrigin} = 'payroll')`
}

/** Minimal shape a reader row needs for confidentiality collapsing. */
export interface PayrollCollapsibleLine {
  entryId: string
  accountId: string
  /** Null for non-party lines, which never collapse. */
  partyId: string | null
  payrollOrigin: boolean
  /** Debit-signed exact decimal. */
  amount: ExactDecimal
}

/**
 * Collapse every party-tagged payroll-origin line into one restricted line
 * per (entry, account), summing amounts with exact-decimal addition. The
 * collapsed line is built by `build` from the first grouped row and the
 * summed amount (so it can mask the party name and memo in its own shape);
 * all other rows pass through in order, with the collapsed line emitted at
 * its group's first position. Totals are preserved by construction, so entry
 * totals, running balances, and closing balances computed downstream still
 * tie out — collapse BEFORE aggregating, never after.
 */
/**
 * Mask payroll party identity in the report-builder entity catalog for
 * readers without payroll.read. The `ledger_lines` entity joins journal lines
 * to parties, so its party columns would otherwise print employee names (and
 * ids, and cheque-number memos) to any reports.read holder through the
 * builder, saved views, exports, and drills — all of which compile from this
 * catalog. The rewrite keeps every column key (existing plans keep running)
 * and only narrows the three identity expressions for party-tagged
 * payroll-origin rows; amounts are untouched here and collapse per
 * entry/account in the execution wrapper, so aggregates still tie to the GL.
 * Readers WITH payroll.read get the catalog untouched.
 */
export function applyPayrollConfidentialityToCatalog(
  catalog: Record<string, ReportEntity>,
  canSeePayroll: boolean,
): Record<string, ReportEntity> {
  if (canSeePayroll) return catalog
  const ledger = catalog.ledger_lines
  if (!ledger || ledger.key !== 'ledger_lines') return catalog
  const from = ledger.from.includes('dsrc')
    ? ledger.from
    : `${ledger.from}\n      LEFT JOIN documents dsrc ON dsrc.id = je.source_document_id AND dsrc.org_id = jl.org_id`
  const payrollParty = `(dsrc.kind = 'pay_run' or je.origin = 'payroll') and jl.party_id is not null`
  const columns = ledger.columns.map((column) => {
    if (column.key === 'party_name') {
      return { ...column, expr: `case when ${payrollParty} then '${PAYROLL_RESTRICTED_PARTY_LABEL}' else ${column.expr} end` }
    }
    if (column.key === 'party_id') {
      return { ...column, expr: `case when ${payrollParty} then null else ${column.expr} end` }
    }
    if (column.key === 'memo') {
      // The entry memo ("Net pay RUN-001") carries no identity; the line memo
      // can carry a cheque number, so restricted rows fall back to the entry.
      return { ...column, expr: `case when ${payrollParty} then je.memo else ${column.expr} end` }
    }
    return column
  })
  return { ...catalog, ledger_lines: { ...ledger, from, columns } }
}

export function collapseRestrictedPayrollLines<T extends PayrollCollapsibleLine>(
  lines: T[],
  build: (first: T, total: ExactDecimal) => T,
): T[] {
  const groups = new Map<string, { first: T; index: number; total: ExactDecimal }>()
  const out: (T | null)[] = []
  for (const line of lines) {
    if (!line.payrollOrigin || line.partyId == null) {
      out.push(line)
      continue
    }
    const key = `${line.entryId}\0${line.accountId}`
    const group = groups.get(key)
    if (!group) {
      groups.set(key, { first: line, index: out.length, total: line.amount })
      out.push(null)
    } else {
      group.total = decimalAdd(group.total, line.amount)
    }
  }
  for (const group of groups.values()) {
    out[group.index] = build(group.first, group.total)
  }
  return out as T[]
}
