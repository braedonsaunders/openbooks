import { isPeriodPreset } from '@openbooks/reports'
import { accountClassTypes } from './account-types'
import type { ReportDrillTarget } from './report-drill'

/** Every CoA balance drills the GL ledger, so callers may read the ledger
 *  fields (mode/from/to, accountIds/accountTypes) without narrowing first. */
export type LedgerDrillTarget = Extract<ReportDrillTarget, { kind: 'ledger' }>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ACCOUNT_TYPE = /^[a-z][a-z0-9_]{0,63}$/

/** The flyout window — current accounting period by default — not the
 *  lifetime/YTD number on the CoA row. The page balance stays as-of today;
 *  the operator narrows or widens supporting lines with the house period
 *  filter. */
export type AccountBalanceDrillWindow = {
  from: string
  to: string
  period?: string
}

function ledgerWindow(ctx: AccountBalanceDrillWindow): Pick<LedgerDrillTarget, 'mode' | 'from' | 'to' | 'period' | 'newestFirst'> | null {
  if (!ISO_DATE.test(ctx.from) || !ISO_DATE.test(ctx.to)) return null
  return {
    mode: 'flow',
    from: ctx.from,
    to: ctx.to,
    period: ctx.period && isPeriodPreset(ctx.period) ? ctx.period : 'this_period',
    newestFirst: true,
  }
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
  from: string
  to: string
  period?: string
}): LedgerDrillTarget | null {
  const label = opts.label.trim()
  if (!UUID.test(opts.accountId) || !label || !ACCOUNT_TYPE.test(opts.type)) return null
  const window = ledgerWindow({ from: opts.from, to: opts.to, period: opts.period })
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
  from: string
  to: string
  period?: string
}): LedgerDrillTarget {
  const accountTypes = accountClassTypes(opts.classKey)
  if (!accountTypes) {
    throw new Error(
      `Unknown chart-of-accounts class "${opts.classKey}". Add it to ACCOUNT_CLASS_TYPES before offering a class-total drill.`,
    )
  }
  const label = opts.label.trim()
  if (!label) {
    throw new Error(`Chart-of-accounts class "${opts.classKey}" needs a non-empty drill label.`)
  }
  const window = ledgerWindow({ from: opts.from, to: opts.to, period: opts.period })
  if (!window) {
    throw new Error(
      `Chart-of-accounts class "${opts.classKey}" drill needs ISO from and to dates.`,
    )
  }
  return { kind: 'ledger', label, accountTypes: [...accountTypes], ...window }
}

/** Entity-list amount-cell hook: only the balance column drills. */
export function accountListBalanceDrill(
  row: Record<string, unknown>,
  columnKey: string,
  ctx: AccountBalanceDrillWindow,
): LedgerDrillTarget | null {
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
    from: ctx.from,
    to: ctx.to,
    period: ctx.period,
  })
}
