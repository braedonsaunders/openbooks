import { ACCOUNT_CLASS_TYPES, PNL_TYPES } from './account-types'
import type { ReportDrillTarget } from './report-drill'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ACCOUNT_TYPE = /^[a-z][a-z0-9_]{0,63}$/

export type AccountBalanceDrillWindow = {
  asOf: string
  fiscalYearStart: string
}

function ledgerWindow(types: readonly string[], ctx: AccountBalanceDrillWindow): Pick<
  Extract<ReportDrillTarget, { kind: 'ledger' }>,
  'mode' | 'from' | 'to'
> | null {
  if (!ISO_DATE.test(ctx.asOf) || !ISO_DATE.test(ctx.fiscalYearStart)) return null
  // CoA balances are fiscal-YTD for the P&L universe and lifetime otherwise.
  // A mixed set that is not entirely P&L must use lifetime, matching the
  // balance SQL (`type not in PNL or date >= fy start`).
  const pnl = types.length > 0 && types.every((type) => PNL_TYPES.includes(type))
  return pnl
    ? { mode: 'flow', from: ctx.fiscalYearStart, to: ctx.asOf }
    : { mode: 'balance', to: ctx.asOf }
}

/**
 * The GL drill behind one chart-of-accounts balance. `accountIds` already
 * expand to descendants in the drill reader, so a summary parent opens the
 * same supporting lines its rolled-up number includes.
 */
export function accountBalanceDrill(opts: {
  accountId: string
  label: string
  type: string
  asOf: string
  fiscalYearStart: string
}): ReportDrillTarget | null {
  const label = opts.label.trim()
  if (!UUID.test(opts.accountId) || !label || !ACCOUNT_TYPE.test(opts.type)) return null
  const window = ledgerWindow([opts.type], { asOf: opts.asOf, fiscalYearStart: opts.fiscalYearStart })
  if (!window) return null
  return { kind: 'ledger', label, accountIds: [opts.accountId], ...window }
}

/**
 * The GL drill behind a CoA class-total balance (Assets, Income, …).
 * Unknown classes refuse by name — an unscoped ledger read would look like
 * the class total while showing every account.
 */
export function accountClassBalanceDrill(opts: {
  classKey: string
  label: string
  asOf: string
  fiscalYearStart: string
}): ReportDrillTarget {
  const accountTypes = ACCOUNT_CLASS_TYPES[opts.classKey]
  if (!accountTypes) {
    throw new Error(
      `Unknown chart-of-accounts class "${opts.classKey}". Add it to ACCOUNT_CLASS_TYPES before offering a class-total drill.`,
    )
  }
  const label = opts.label.trim()
  if (!label) {
    throw new Error(`Chart-of-accounts class "${opts.classKey}" needs a non-empty drill label.`)
  }
  const window = ledgerWindow(accountTypes, { asOf: opts.asOf, fiscalYearStart: opts.fiscalYearStart })
  if (!window) {
    throw new Error(
      `Chart-of-accounts class "${opts.classKey}" drill needs ISO as-of and fiscal-year-start dates.`,
    )
  }
  return { kind: 'ledger', label, accountTypes: [...accountTypes], ...window }
}

/** Entity-list amount-cell hook: only the balance column drills. */
export function accountListBalanceDrill(
  row: Record<string, unknown>,
  columnKey: string,
  ctx: AccountBalanceDrillWindow,
): ReportDrillTarget | null {
  if (columnKey !== 'balance') return null
  const id = typeof row.id === 'string' ? row.id : ''
  const type =
    (typeof row.drill_account_type === 'string' && row.drill_account_type) ||
    (typeof row.type === 'string' ? row.type : '')
  const number =
    (typeof row.drill_account_number === 'string' && row.drill_account_number) ||
    (typeof row.number === 'string' ? row.number : '')
  const name =
    (typeof row.drill_account_name === 'string' && row.drill_account_name) ||
    (typeof row.name === 'string' ? row.name : '')
  return accountBalanceDrill({
    accountId: id,
    label: `${number} ${name}`.trim() || id,
    type,
    asOf: ctx.asOf,
    fiscalYearStart: ctx.fiscalYearStart,
  })
}
