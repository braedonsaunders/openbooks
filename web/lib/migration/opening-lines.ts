import { canonicalDecimal } from '@openbooks/engine/money'
import { fitsLedgerRange, fromUnits, toUnits } from '@openbooks/engine/money'
import { moneyRefusal } from '@openbooks/engine/money/decimal-refusal'

/**
 * Turn staged trial-balance rows into opening journal lines. Pure: account
 * resolution is supplied by the caller, and nothing here writes. The rules
 * are the ones a reviewer applies to an opening trial balance:
 *
 * - every included row resolves to exactly one posting account;
 * - amounts are exact decimals as typed (no separator or symbol coercion —
 *   a reformatted spreadsheet must never be silently re-valued);
 * - a row is either debit/credit columns or one signed amount (debit-positive);
 * - zero rows carry no ledger effect and are skipped;
 * - the result balances exactly, or the difference is reported, never plugged.
 */

export interface OpeningColumns {
  account: string
  debit?: string | null
  credit?: string | null
  amount?: string | null
  description?: string | null
}

export type AccountResolution = { id: string; label: string } | { refusal: string }

export interface OpeningLine {
  rowNo: number
  accountId: string
  accountLabel: string
  amount: string
  description: string | null
}

export interface OpeningIssue {
  rowNo: number
  message: string
}

export type OpeningLinesResult =
  | { ok: true; lines: OpeningLine[]; totalDebits: string; totalCredits: string; net: string; skippedZeroRows: number }
  | { ok: false; issues: OpeningIssue[] }

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value.trim() : String(value)
}

/** Exact decimal or a refusal; blank reads as zero only for an optional side column. */
function amountOf(raw: unknown, label: string, optional = false): { units: bigint } | { refusal: string } {
  if (optional && (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === ''))) return { units: 0n }
  const exact = typeof raw === 'string' ? canonicalDecimal(raw.trim(), 4) : null
  if (exact === null || !fitsLedgerRange(exact)) return { refusal: moneyRefusal(label, raw) }
  return { units: toUnits(exact) }
}

export const MAX_OPENING_ROWS = 5_000

export function openingLinesFromRows(input: {
  rows: readonly { rowNo: number; data: Record<string, unknown> }[]
  columns: OpeningColumns
  excludeRows?: ReadonlySet<number>
  resolveAccount: (text: string) => AccountResolution
  /**
   * Account cell text → the account that row posts to instead. A spreadsheet
   * migration re-points the receivables and payables control lines to the
   * opening clearing account, because the imported open documents rebuild
   * those control balances themselves.
   */
  remap?: ReadonlyMap<string, AccountResolution>
}): OpeningLinesResult {
  const { columns } = input
  const signed = Boolean(columns.amount)
  if (signed && (columns.debit || columns.credit)) {
    return { ok: false, issues: [{ rowNo: 0, message: 'Use either one signed amount column or debit and credit columns, not both.' }] }
  }
  if (!signed && !columns.debit && !columns.credit) {
    return { ok: false, issues: [{ rowNo: 0, message: 'Name the amount column, or the debit and credit columns.' }] }
  }
  if (input.rows.length > MAX_OPENING_ROWS) {
    return { ok: false, issues: [{ rowNo: 0, message: `An opening trial balance is limited to ${MAX_OPENING_ROWS} rows — summarize sub-accounts before importing.` }] }
  }
  const issues: OpeningIssue[] = []
  const lines: OpeningLine[] = []
  let debits = 0n, credits = 0n, skippedZeroRows = 0
  for (const row of input.rows) {
    if (input.excludeRows?.has(row.rowNo)) continue
    const accountText = cellText(row.data[columns.account])
    let units = 0n
    let amountRefused = false
    if (signed) {
      const parsed = amountOf(row.data[columns.amount!], `Row ${row.rowNo} amount`)
      if ('refusal' in parsed) { issues.push({ rowNo: row.rowNo, message: parsed.refusal }); amountRefused = true } else units = parsed.units
    } else {
      const debit = columns.debit ? amountOf(row.data[columns.debit], `Row ${row.rowNo} debit`, true) : { units: 0n }
      const credit = columns.credit ? amountOf(row.data[columns.credit], `Row ${row.rowNo} credit`, true) : { units: 0n }
      if ('refusal' in debit) { issues.push({ rowNo: row.rowNo, message: debit.refusal }); amountRefused = true }
      if ('refusal' in credit) { issues.push({ rowNo: row.rowNo, message: credit.refusal }); amountRefused = true }
      if (!amountRefused && 'units' in debit && 'units' in credit) units = debit.units - credit.units
    }
    if (amountRefused) continue
    if (!accountText) {
      if (units !== 0n) issues.push({ rowNo: row.rowNo, message: `Row ${row.rowNo} carries an amount but no account — name the account, or exclude the row if it is a total.` })
      continue
    }
    if (units === 0n) { skippedZeroRows++; continue }
    const account = input.remap?.get(accountText) ?? input.resolveAccount(accountText)
    if ('refusal' in account) { issues.push({ rowNo: row.rowNo, message: `Row ${row.rowNo}: ${account.refusal}` }); continue }
    if (units > 0n) debits += units
    else credits -= units
    const description = columns.description ? cellText(row.data[columns.description]) || null : null
    lines.push({ rowNo: row.rowNo, accountId: account.id, accountLabel: account.label, amount: fromUnits(units), description })
  }
  if (issues.length) return { ok: false, issues: issues.slice(0, 50) }
  if (lines.length === 0) return { ok: false, issues: [{ rowNo: 0, message: 'No row carries a non-zero balance — check the column choices.' }] }
  return { ok: true, lines, totalDebits: fromUnits(debits), totalCredits: fromUnits(credits), net: fromUnits(debits - credits), skippedZeroRows }
}

export interface AccountRef { id: string; number: string | null; name: string; isActive: boolean; isSummary: boolean }

/**
 * Resolve an account cell by exact account number first, then by exact name
 * (case-insensitive). An ambiguous name, an inactive account, or a summary
 * account refuses with the reason; no fuzzy match is attempted.
 */
export function accountResolver(accounts: readonly AccountRef[]): (text: string) => AccountResolution {
  const byNumber = new Map<string, AccountRef>()
  const byName = new Map<string, AccountRef[]>()
  for (const account of accounts) {
    if (account.number) byNumber.set(account.number.trim(), account)
    const key = account.name.trim().toLowerCase()
    byName.set(key, [...(byName.get(key) ?? []), account])
  }
  const label = (account: AccountRef) => account.number ? `${account.number} ${account.name}` : account.name
  const usable = (account: AccountRef): AccountResolution => {
    if (account.isSummary) return { refusal: `${label(account)} is a summary account — post opening balances to its posting sub-accounts.` }
    if (!account.isActive) return { refusal: `${label(account)} is inactive — reactivate it or map the balance to an active account.` }
    return { id: account.id, label: label(account) }
  }
  return (text) => {
    const exact = byNumber.get(text)
    if (exact) return usable(exact)
    // "1000 Cash" style cells: a leading token that is an exact account number.
    const leading = /^(\S+)\s+/.exec(text)?.[1]
    if (leading && byNumber.has(leading)) return usable(byNumber.get(leading)!)
    const named = byName.get(text.toLowerCase()) ?? []
    if (named.length === 1) return usable(named[0]!)
    if (named.length > 1) return { refusal: `"${text}" names ${named.length} accounts — use the account number.` }
    return { refusal: `no account numbered or named "${text}" — create it in the chart of accounts or correct the cell.` }
  }
}
