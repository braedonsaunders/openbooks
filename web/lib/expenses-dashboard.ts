import 'server-only'
import { sql } from 'drizzle-orm'
import { addCalendarMonthsStart, businessToday, startOfMonth } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { fromUnits, roundDiv, toUnits } from '@openbooks/engine/src/money.ts'

/**
 * Expense-reports dashboard — the /expenses cockpit's data. This is the
 * expense-analysis slice SPLIT OUT of the analytics Spend Velocity dashboard
 * (top spenders, category current-vs-prior, expense-vs-bill monthly trend —
 * same queries, same math) plus the operational layer analytics never had:
 * the approval pipeline (draft → pending → approved → posted) and its queue.
 * Spend Velocity keeps the org-wide account/vendor velocity forensics;
 * everything employee-expense-report-shaped lives here.
 *
 * Window: trailing 12 months, compared against the 12 months before that.
 */

export interface ExpenseSpender {
  employeeId: string
  employeeName: string
  totalSpend: string
  priorSpend: string
  reportCount: number
  changePct: number
}

export interface ExpenseCategory {
  categoryId: string
  categoryName: string
  currentAmount: string
  priorAmount: string
  changePct: number
}

export interface ExpenseQueueItem {
  id: string
  documentNumber: string
  employee: string | null
  date: string
  total: string
  status: string
}

export interface ExpensesDashboardData {
  period: { from: string; to: string; priorFrom: string }
  pipeline: {
    draftCount: number
    draftTotal: string
    pendingCount: number
    pendingTotal: string
    approvedCount: number
    approvedTotal: string
    postedMonthTotal: string
    postedMonthCount: number
  }
  summary: {
    expenseReportTotal: string
    vendorBillTotal: string
    highSpenderCount: number
    categoryIncreaseTotal: string
  }
  topSpenders: ExpenseSpender[]
  categories: ExpenseCategory[]
  monthlyTrends: { month: string; expenseAmount: string; billAmount: string }[]
  queue: ExpenseQueueItem[]
}

type MoneyInput = string | number
type SqlNumber = MoneyInput | null

interface ExpenseTrendRow extends Record<string, unknown> {
  month: string | null
  expense_amount: SqlNumber
  bill_amount: SqlNumber
}

const moneyUnits = (value: unknown): bigint => {
  if (value === null || value === undefined) return 0n
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error('money values must be decimal strings or numbers')
  }
  return toUnits(value)
}

const canonicalMoney = (value: unknown): string => fromUnits(moneyUnits(value))

const sumMoney = (values: readonly MoneyInput[]): string =>
  fromUnits(values.reduce((total, value) => total + toUnits(value), 0n))

/** Round an exact percentage change to one decimal place without floats. */
const percentageChange = (current: bigint, prior: bigint): number => {
  if (prior <= 0n) return 0
  // (current - prior) / prior * 100, rounded to tenths of a percent.
  return Number(roundDiv((current - prior) * 1000n, prior)) / 10
}

export interface ExpenseSummaryInputs {
  topSpenderTotals: readonly MoneyInput[]
  vendorBillTotals: readonly MoneyInput[]
  categoryIncreaseTotal: MoneyInput
  highSpenderCount: number
}

/**
 * Aggregate dashboard totals in ledger units. The returned canonical strings
 * remain exact until the currency-aware formatter renders them in the UI.
 */
export function aggregateExpenseSummary({
  topSpenderTotals,
  vendorBillTotals,
  categoryIncreaseTotal,
  highSpenderCount,
}: ExpenseSummaryInputs): ExpensesDashboardData['summary'] {
  return {
    expenseReportTotal: sumMoney(topSpenderTotals),
    vendorBillTotal: sumMoney(vendorBillTotals),
    highSpenderCount,
    categoryIncreaseTotal: canonicalMoney(categoryIncreaseTotal),
  }
}

export async function expensesDashboard(orgId: string): Promise<ExpensesDashboardData> {
  const to = await businessToday(orgId)
  const monthStart = startOfMonth(to)
  const from = addCalendarMonthsStart(to, -11)
  const priorFrom = addCalendarMonthsStart(to, -23)

  const [pipeRes, spenderRes, catRes, trendRes, queueRes] = (await Promise.all([
    // Approval pipeline — live counts/values by status + posted this month.
    db.execute(sql`
      select
        count(*) filter (where status = 'draft') as draft_count,
        coalesce(sum(total) filter (where status = 'draft'), 0) as draft_total,
        count(*) filter (where status = 'pending_approval') as pending_count,
        coalesce(sum(total) filter (where status = 'pending_approval'), 0) as pending_total,
        count(*) filter (where status = 'approved') as approved_count,
        coalesce(sum(total) filter (where status = 'approved'), 0) as approved_total,
        count(*) filter (where status = 'posted' and posting_date >= ${monthStart}) as posted_month_count,
        coalesce(sum(total) filter (where status = 'posted' and posting_date >= ${monthStart}), 0) as posted_month_total
      from documents
      where org_id = ${orgId} and kind = 'expense_report' and voided_at is null
    `),
    // Top spenders — expense reports by employee, current vs prior window
    // (verbatim Spend Velocity query 7).
    db.execute(sql`
      select d.party_id as employee_id, coalesce(p.display_name, 'Unknown') as employee_name,
        sum(d.total) filter (where d.posting_date >= ${from}) as current_spend,
        sum(d.total) filter (where d.posting_date < ${from}) as prior_spend,
        count(*) filter (where d.posting_date >= ${from}) as report_count
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      where d.org_id = ${orgId} and d.kind = 'expense_report' and d.voided_at is null
        and d.posting_date >= ${priorFrom} and d.posting_date <= ${to}
      group by 1, 2
      having sum(d.total) > 0
      order by 3 desc nulls last
      limit 50
    `),
    // Expense categories (accounts on expense-report lines), current vs prior.
    db.execute(sql`
      select l.account_id as category_id, a.name as category_name,
        sum(l.amount) filter (where e.posting_date >= ${from}) as current_amount,
        sum(l.amount) filter (where e.posting_date < ${from}) as prior_amount
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join documents d on d.id = e.source_document_id and d.org_id = e.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      where l.org_id = ${orgId} and d.voided_at is null
        and d.kind = 'expense_report'
        and a.type in ('expense', 'expense_other', 'expense_deferred', 'cogs')
        and e.posting_date >= ${priorFrom} and e.posting_date <= ${to}
      group by 1, 2
      order by 3 desc nulls last
      limit 50
    `),
    // Monthly expense-report vs vendor-bill spend (the SV comparison chart).
    db.execute(sql`
      select to_char(e.posting_date, 'YYYY-MM') as month,
        coalesce(sum(l.amount) filter (where d.kind = 'expense_report'), 0) as expense_amount,
        coalesce(sum(l.amount) filter (where d.kind = 'vendor_bill'), 0) as bill_amount
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join documents d on d.id = e.source_document_id and d.org_id = e.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      where l.org_id = ${orgId} and d.voided_at is null
        and d.kind in ('expense_report', 'vendor_bill')
        and a.type in ('expense', 'expense_other', 'expense_deferred', 'cogs')
        and e.posting_date >= ${from} and e.posting_date <= ${to}
      group by 1
      order by 1
    `),
    // Approval queue — oldest unfinished reports first.
    db.execute(sql`
      select d.id, d.document_number, d.document_date::text as date, d.total, d.status,
        p.display_name as employee
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      where d.org_id = ${orgId} and d.kind = 'expense_report' and d.voided_at is null
        and d.status in ('pending_approval', 'draft', 'approved')
      order by case d.status when 'pending_approval' then 0 when 'approved' then 1 else 2 end,
        d.document_date asc
      limit 8
    `),
  ]))

  const pipe = pipeRes.rows[0] ?? {}
  const topSpenders: ExpenseSpender[] = (spenderRes.rows as any[])
    .map((r) => {
      const current = toUnits(r.current_spend ?? 0)
      const prior = toUnits(r.prior_spend ?? 0)
      return {
        employeeId: r.employee_id,
        employeeName: r.employee_name,
        totalSpend: fromUnits(current),
        priorSpend: fromUnits(prior),
        reportCount: Number(r.report_count ?? 0),
        changePct: percentageChange(current, prior),
      }
    })
    .filter((s) => toUnits(s.totalSpend) > 0n || toUnits(s.priorSpend) > 0n)

  let categoryIncreaseTotal = 0n
  const categories: ExpenseCategory[] = (catRes.rows as any[])
    .map((r) => {
      const current = toUnits(r.current_amount ?? 0)
      const prior = toUnits(r.prior_amount ?? 0)
      const changePct = percentageChange(current, prior)
      if (changePct > 10) categoryIncreaseTotal += current - prior
      return {
        categoryId: r.category_id,
        categoryName: r.category_name ?? '',
        currentAmount: fromUnits(current),
        priorAmount: fromUnits(prior),
        changePct,
      }
    })
    .filter((c) => toUnits(c.currentAmount) > 0n || toUnits(c.priorAmount) > 0n)

  const monthlyTrends = (trendRes.rows as ExpenseTrendRow[]).map((r) => ({
    month: String(r.month),
    expenseAmount: canonicalMoney(r.expense_amount),
    billAmount: canonicalMoney(r.bill_amount),
  }))

  return {
    period: { from, to, priorFrom },
    pipeline: {
      draftCount: Number(pipe.draft_count ?? 0),
      draftTotal: canonicalMoney(pipe.draft_total),
      pendingCount: Number(pipe.pending_count ?? 0),
      pendingTotal: canonicalMoney(pipe.pending_total),
      approvedCount: Number(pipe.approved_count ?? 0),
      approvedTotal: canonicalMoney(pipe.approved_total),
      postedMonthTotal: canonicalMoney(pipe.posted_month_total),
      postedMonthCount: Number(pipe.posted_month_count ?? 0),
    },
    summary: aggregateExpenseSummary({
      topSpenderTotals: topSpenders.map((spender) => spender.totalSpend),
      vendorBillTotals: monthlyTrends.map((trend) => trend.billAmount),
      categoryIncreaseTotal: fromUnits(categoryIncreaseTotal),
      highSpenderCount: topSpenders.filter((s) => s.changePct > 20).length,
    }),
    topSpenders,
    categories,
    monthlyTrends,
    queue: (queueRes.rows as any[]).map((r) => ({
      id: r.id,
      documentNumber: r.document_number ?? '',
      employee: r.employee ?? null,
      date: String(r.date ?? ''),
      total: canonicalMoney(r.total),
      status: String(r.status),
    })),
  }
}
