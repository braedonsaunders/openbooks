import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { BANK_KINDS } from '../documents'

/**
 * Banking module home — one light round trip for the workspace landing
 * cockpit: the account roster (the page's headline object), 13-week balance
 * history for sparklines/trend, and the live-directory badges. Deliberately
 * NOT the cash forecast engine — that stays on /banking/cash; everything here
 * is cheap counts and sums.
 */

export interface BankingAccountRow {
  id: string
  number: string | null
  name: string
  type: string // 'asset_bank' | 'liability_card'
  currency: string | null
  balance: number
  unmatched: number
  openReconciliationId: string | null
  reconciledThrough: string | null
  lastStatementDate: string | null
  lastImportedAt: string | null
  /** Weekly end-of-week balances, oldest → newest (13 points incl. current). */
  spark: number[]
}

export interface BankingHome {
  accounts: BankingAccountRow[]
  totalCash: number
  totalCards: number
  unmatchedLines: number
  openRecons: number
  /** Net posted flow across bank accounts over the trailing 7 days. */
  netFlow7d: number
  /** Org cash (asset_bank) end-of-week balances, oldest → newest. */
  trend: { weekStart: string; balance: number }[]
  badges: {
    activeRules: number
    totalRules: number
    statements: number
    lastImportedAt: string | null
    txns7d: number
  }
}

const TREND_WEEKS = 13

export async function bankingHome(orgId: string): Promise<BankingHome> {
  const txList = sql`(${sql.join(BANK_KINDS.map((kind) => sql`${kind}`), sql`, `)})`

  const [rosterRes, flowsRes, badgesRes] = (await Promise.all([
    // Roster — one row per reconcilable account with balance + workflow state.
    db.execute(sql`
      select a.id, a.number, a.name, a.type, a.currency_restriction,
             coalesce(bal.balance, 0) as balance,
             coalesce(unm.n, 0) as unmatched,
             openrec.id as open_reconciliation_id,
             rec.through as reconciled_through,
             st.statement_date as last_statement_date,
             st.imported_at as last_imported_at
        from accounts a
        left join lateral (
          select sum(jl.amount) as balance
            from journal_lines jl
            join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
           where jl.account_id = a.id) bal on true
        left join lateral (
          select count(*) as n
            from bank_statement_lines l
            join bank_statements s on s.id = l.statement_id
           where s.account_id = a.id and l.match_status = 'unmatched') unm on true
        left join lateral (
          select r.id from reconciliations r
           where r.account_id = a.id and r.status <> 'signed_off'
           order by r.created_at desc limit 1) openrec on true
        left join lateral (
          select max(r.through_date) as through from reconciliations r
           where r.account_id = a.id and r.status = 'signed_off') rec on true
        left join lateral (
          select s.statement_date, s.imported_at from bank_statements s
           where s.account_id = a.id
           order by s.imported_at desc limit 1) st on true
       where a.org_id = ${orgId} and a.reconcilable and not a.is_summary
         and a.type in ('asset_bank', 'liability_card')
       order by a.type, coalesce(bal.balance, 0) desc
    `),
    // Weekly net flow per account over the sparkline window (+ the trailing
    // 7-day figure, folded in as a second grouped shape would cost another
    // scan — computed in JS from daily-precision rows instead is overkill;
    // one extra filtered aggregate below keeps this a single pass).
    db.execute(sql`
      select jl.account_id,
             (date_trunc('week', je.posting_date))::date as wk,
             sum(jl.amount) as flow,
             sum(jl.amount) filter (where je.posting_date >= current_date - 7) as flow_7d
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
        join accounts a on a.id = jl.account_id
       where a.org_id = ${orgId} and a.reconcilable and not a.is_summary
         and a.type in ('asset_bank', 'liability_card')
         and je.posting_date >= (date_trunc('week', current_date) - interval '${sql.raw(String(TREND_WEEKS - 1))} weeks')
       group by 1, 2
    `),
    // Directory badges — org-wide counts for the workspace's other pages.
    db.execute(sql`
      select
        (select count(*) from bank_match_rules r where r.org_id = ${orgId} and r.is_active) as active_rules,
        (select count(*) from bank_match_rules r where r.org_id = ${orgId}) as total_rules,
        (select count(*) from bank_statements s where s.org_id = ${orgId}) as statements,
        (select max(s.imported_at) from bank_statements s where s.org_id = ${orgId}) as last_imported_at,
        (select count(*) from documents d
          where d.org_id = ${orgId} and d.kind in ${txList}
            and d.document_date >= current_date - 7) as txns_7d
    `),
  ])) as unknown as [{ rows: any[] }, { rows: any[] }, { rows: any[] }]

  // Week grid, oldest → newest, aligned with date_trunc('week', …) (Monday).
  const weekStarts: string[] = []
  {
    const now = new Date()
    const day = (now.getUTCDay() + 6) % 7 // Monday = 0
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day))
    for (let i = TREND_WEEKS - 1; i >= 0; i--) {
      const d = new Date(monday)
      d.setUTCDate(monday.getUTCDate() - i * 7)
      weekStarts.push(d.toISOString().slice(0, 10))
    }
  }

  // Per-account weekly flows → end-of-week balances walked BACKWARD from the
  // current balance (avoids a 13× running-sum query).
  const flows = new Map<string, Map<string, number>>()
  let netFlow7d = 0
  for (const r of flowsRes.rows) {
    const wk = String(r.wk).slice(0, 10)
    let m = flows.get(r.account_id)
    if (!m) flows.set(r.account_id, (m = new Map()))
    m.set(wk, Number(r.flow))
  }

  const accounts: BankingAccountRow[] = rosterRes.rows.map((a: any) => {
    const balance = Number(a.balance)
    const weekly = flows.get(a.id)
    const spark: number[] = new Array(weekStarts.length)
    let running = balance
    for (let i = weekStarts.length - 1; i >= 0; i--) {
      spark[i] = running
      running -= weekly?.get(weekStarts[i]) ?? 0
    }
    return {
      id: a.id,
      number: a.number,
      name: a.name,
      type: a.type,
      currency: a.currency_restriction,
      balance,
      unmatched: Number(a.unmatched),
      openReconciliationId: a.open_reconciliation_id,
      reconciledThrough: a.reconciled_through,
      lastStatementDate: a.last_statement_date,
      lastImportedAt: a.last_imported_at ? String(a.last_imported_at) : null,
      spark,
    }
  })

  const bankIds = new Set(accounts.filter((a) => a.type === 'asset_bank').map((a) => a.id))
  for (const r of flowsRes.rows) {
    if (r.flow_7d != null && bankIds.has(r.account_id)) netFlow7d += Number(r.flow_7d)
  }

  const trend = weekStarts.map((weekStart, i) => ({
    weekStart,
    balance: accounts.reduce((sum, a) => (a.type === 'asset_bank' ? sum + a.spark[i] : sum), 0),
  }))

  const badge = badgesRes.rows[0] ?? {}
  return {
    accounts,
    totalCash: accounts.reduce((s, a) => (a.type === 'asset_bank' ? s + a.balance : s), 0),
    totalCards: accounts.reduce((s, a) => (a.type === 'liability_card' ? s + a.balance : s), 0),
    unmatchedLines: accounts.reduce((s, a) => s + a.unmatched, 0),
    openRecons: accounts.reduce((s, a) => s + (a.openReconciliationId ? 1 : 0), 0),
    netFlow7d,
    trend,
    badges: {
      activeRules: Number(badge.active_rules ?? 0),
      totalRules: Number(badge.total_rules ?? 0),
      statements: Number(badge.statements ?? 0),
      lastImportedAt: badge.last_imported_at ? String(badge.last_imported_at) : null,
      txns7d: Number(badge.txns_7d ?? 0),
    },
  }
}
