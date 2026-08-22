import 'server-only'
import { sql } from 'drizzle-orm'
import { addCalendarMonthsStart, businessToday, startOfMonth } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'

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
  totalSpend: number
  priorSpend: number
  reportCount: number
  changePct: number
}

export interface ExpenseCategory {
  categoryId: string
  categoryName: string
  currentAmount: number
  priorAmount: number
  changePct: number
}

export interface ExpenseQueueItem {
  id: string
  documentNumber: string
  employee: string | null
  date: string
  total: number
  status: string
}

export interface ExpensesDashboardData {
  period: { from: string; to: string; priorFrom: string }
  pipeline: {
    draftCount: number
    draftTotal: number
    pendingCount: number
    pendingTotal: number
    approvedCount: number
    approvedTotal: number
    postedMonthTotal: number
    postedMonthCount: number
  }
  summary: {
    expenseReportTotal: number
    vendorBillTotal: number
    highSpenderCount: number
    categoryIncreaseTotal: number
  }
  topSpenders: ExpenseSpender[]
  categories: ExpenseCategory[]
  monthlyTrends: { month: string; expenseAmount: number; billAmount: number }[]
  queue: ExpenseQueueItem[]
}

const r1 = (n: number) => Math.round(n * 10) / 10

export async function expensesDashboard(orgId: string): Promise<ExpensesDashboardData> {
  const to = await businessToday(orgId)
  const monthStart = startOfMonth(to)
  const from = addCalendarMonthsStart(to, -11)
  const priorFrom = addCalendarMonthsStart(to, -23)

  const [pipeRes, spenderRes, catRes, trendRes, queueRes] = (await Promise.all([
    // Approval pipeline — live counts/values by status + posted this month.
    db.execute<any>(sql`
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
    db.execute<any>(sql`
      select d.party_id as employee_id, coalesce(p.display_name, 'Unknown') as employee_name,
        sum(d.total) filter (where d.posting_date >= ${from}) as current_spend,
        sum(d.total) filter (where d.posting_date < ${from}) as prior_spend,
        count(*) filter (where d.posting_date >= ${from}) as report_count
      from documents d
      left join parties p on p.id = d.party_id
      where d.org_id = ${orgId} and d.kind = 'expense_report' and d.voided_at is null
        and d.posting_date >= ${priorFrom} and d.posting_date <= ${to}
      group by 1, 2
      having sum(d.total) > 0
      order by 3 desc nulls last
      limit 50
    `),
    // Expense categories (accounts on expense-report lines), current vs prior.
    db.execute<any>(sql`
      select l.account_id as category_id, a.name as category_name,
        sum(l.amount) filter (where e.posting_date >= ${from}) as current_amount,
        sum(l.amount) filter (where e.posting_date < ${from}) as prior_amount
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join documents d on d.id = e.source_document_id
      join accounts a on a.id = l.account_id
      where l.org_id = ${orgId} and d.voided_at is null
        and d.kind = 'expense_report'
        and a.type in ('expense', 'expense_other', 'expense_deferred', 'cogs')
        and e.posting_date >= ${priorFrom} and e.posting_date <= ${to}
      group by 1, 2
      order by 3 desc nulls last
      limit 50
    `),
    // Monthly expense-report vs vendor-bill spend (the SV comparison chart).
    db.execute<any>(sql`
      select to_char(e.posting_date, 'YYYY-MM') as month,
        coalesce(sum(l.amount) filter (where d.kind = 'expense_report'), 0) as expense_amount,
        coalesce(sum(l.amount) filter (where d.kind = 'vendor_bill'), 0) as bill_amount
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join documents d on d.id = e.source_document_id
      join accounts a on a.id = l.account_id
      where l.org_id = ${orgId} and d.voided_at is null
        and d.kind in ('expense_report', 'vendor_bill')
        and a.type in ('expense', 'expense_other', 'expense_deferred', 'cogs')
        and e.posting_date >= ${from} and e.posting_date <= ${to}
      group by 1
      order by 1
    `),
    // Approval queue — oldest unfinished reports first.
    db.execute<any>(sql`
      select d.id, d.document_number, d.document_date::text as date, d.total, d.status,
        p.display_name as employee
      from documents d
      left join parties p on p.id = d.party_id
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
      const current = Number(r.current_spend ?? 0)
      const prior = Number(r.prior_spend ?? 0)
      return {
        employeeId: r.employee_id,
        employeeName: r.employee_name,
        totalSpend: current,
        priorSpend: prior,
        reportCount: Number(r.report_count ?? 0),
        changePct: prior > 0 ? r1(((current - prior) / prior) * 100) : 0,
      }
    })
    .filter((s) => s.totalSpend > 0 || s.priorSpend > 0)

  let categoryIncreaseTotal = 0
  const categories: ExpenseCategory[] = (catRes.rows as any[])
    .map((r) => {
      const current = Number(r.current_amount ?? 0)
      const prior = Number(r.prior_amount ?? 0)
      const changePct = prior > 0 ? r1(((current - prior) / prior) * 100) : 0
      if (changePct > 10) categoryIncreaseTotal += current - prior
      return { categoryId: r.category_id, categoryName: r.category_name ?? '', currentAmount: current, priorAmount: prior, changePct }
    })
    .filter((c) => c.currentAmount > 0 || c.priorAmount > 0)

  const monthlyTrends = (trendRes.rows as any[]).map((r) => ({
    month: String(r.month),
    expenseAmount: Number(r.expense_amount ?? 0),
    billAmount: Number(r.bill_amount ?? 0),
  }))

  return {
    period: { from, to, priorFrom },
    pipeline: {
      draftCount: Number(pipe.draft_count ?? 0),
      draftTotal: Number(pipe.draft_total ?? 0),
      pendingCount: Number(pipe.pending_count ?? 0),
      pendingTotal: Number(pipe.pending_total ?? 0),
      approvedCount: Number(pipe.approved_count ?? 0),
      approvedTotal: Number(pipe.approved_total ?? 0),
      postedMonthTotal: Number(pipe.posted_month_total ?? 0),
      postedMonthCount: Number(pipe.posted_month_count ?? 0),
    },
    summary: {
      expenseReportTotal: Math.round(topSpenders.reduce((s, x) => s + x.totalSpend, 0)),
      vendorBillTotal: Math.round(monthlyTrends.reduce((s, m) => s + m.billAmount, 0)),
      highSpenderCount: topSpenders.filter((s) => s.changePct > 20).length,
      categoryIncreaseTotal: Math.round(categoryIncreaseTotal),
    },
    topSpenders,
    categories,
    monthlyTrends,
    queue: (queueRes.rows as any[]).map((r) => ({
      id: r.id,
      documentNumber: r.document_number ?? '',
      employee: r.employee ?? null,
      date: String(r.date ?? ''),
      total: Number(r.total ?? 0),
      status: String(r.status),
    })),
  }
}
