'use client'

import { useMoney } from '@/components/money-provider'
import { useViewerFormat } from '@/lib/viewer-format'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  Activity,
  AlertTriangle,
  BookOpen,
  CalendarCheck,
  CalendarClock,
  CircleDollarSign,
  ClipboardList,
  FileText,
  Hourglass,
  Landmark,
  Layers,
  ListChecks,
  Wallet,
  NotebookPen,
  Percent,
  Receipt,
  Scale,
  Sparkles,
  Store,
  TrendingUp,
  Users,
} from 'lucide-react'
import { Badge } from '@openbooks/ui'
import { cmp as compareMoney } from '@openbooks/engine/money'
import { CardShell, EmptyRow, MetricTile, type MetricTone, type WidgetCardProps } from './_widget-tiles'
import type { DashboardMetrics } from './_metrics'
import { WIDGETS } from './_widget-registry'
import { FinancialWidgetCard } from './_widget-views-financial'
import { CashWidgetCard } from './_widget-views-cash'
import { CustomerWidgetCard } from './_widget-views-customers'
import { VendorWidgetCard } from './_widget-views-vendors'
import { ProjectWidgetCard } from './_widget-views-projects'
import { RiskWidgetCard } from './_widget-views-risk'

/** Widgets extracted from an Analytics dashboard render in that dashboard's widget module. */
const ANALYTICS_WIDGET_CARDS: Record<string, (props: WidgetCardProps) => React.ReactNode> = {
  'financial-health': FinancialWidgetCard,
  cashflow: CashWidgetCard,
  'customer-intelligence': CustomerWidgetCard,
  'vendor-performance': VendorWidgetCard,
  'spend-velocity': VendorWidgetCard,
  'true-cost': ProjectWidgetCard,
  utilization: ProjectWidgetCard,
  sentinel: RiskWidgetCard,
}

export function WidgetCard({
  widgetId,
  data,
}: {
  widgetId: string
  data: DashboardMetrics
}) {
  const { money } = useMoney()
  const { date, dateTime, number } = useViewerFormat()
  const t = useTranslations('dashboard')
  // The cut-off the as-of readers used, so a tile that excludes
  // future-dated documents says which day it is cut at.
  // Noon-anchored: a bare YYYY-MM-DD parses as UTC midnight and would
  // render a day early west of Greenwich.
  const asOf = data.asOfDate
    ? t('metricContext.asOf', {
        date: date(new Date(`${data.asOfDate}T12:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' }),
      })
    : null
  const withAsOf = (hint: string) => (asOf ? `${hint} · ${asOf}` : hint)
  // The P&L window plus the subsidiary scope it covers: a restricted caller
  // scoped to one subtree reads the scope name here, never as the whole
  // company. Subsidiary names need no translation.
  const plWindowHint = (periodLabel: string | null, scopeLabel: string | null) => {
    const window = periodLabel ?? t('metricContext.monthToDate')
    return scopeLabel ? `${window} · ${scopeLabel}` : window
  }
  // Money without a currency is a mislabelled figure: with no base currency
  // the tile refuses by name instead of formatting as dollars.
  const withoutCurrency = (label: string, icon: React.ReactNode, href: string, tone: MetricTone) => (
    <MetricTile icon={icon} label={label} value="—" href={href} tone={tone} hint={withAsOf(t('metricContext.noBaseCurrency'))} />
  )
  // Noon-anchored like the as-of label above: a bare YYYY-MM-DD parses as
  // UTC midnight and would render a day early west of Greenwich.
  const fmtDay = (iso: string) =>
    date(new Date(`${iso}T12:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' })
  // Runway weeks read whole past ten, one decimal below — the precise
  // figure lives behind the tile's link on the banking page.
  const displayWeeks = (weeks: number) => (weeks >= 10 ? Math.round(weeks) : Math.round(weeks * 10) / 10)

  const source = WIDGETS[widgetId]?.analyticsSource
  const AnalyticsWidget = source ? ANALYTICS_WIDGET_CARDS[source] : undefined
  if (AnalyticsWidget) return <AnalyticsWidget widgetId={widgetId} data={data} />

  switch (widgetId) {
    case 'kpi-journal-lines':
      return <MetricTile icon={<BookOpen size={15} />} label={t('widgets.journalLines')} value={String(data.journalLineCount)} href="/journal" tone="teal" />
    case 'kpi-accounts-active':
      return <MetricTile icon={<Layers size={15} />} label={t('widgets.activeAccounts')} value={String(data.accountCount)} href="/accounts" tone="sky" />
    case 'kpi-entries-today':
      return <MetricTile icon={<FileText size={15} />} label={t('widgets.entriesToday')} value={String(data.entriesToday)} href="/journal" tone="teal" hint={t('metricContext.today')} />
    case 'kpi-pending-approvals':
      return <MetricTile icon={<ClipboardList size={15} />} label={t('widgets.pendingApprovals')} value={String(data.pendingApprovals)} href="/inbox?tab=all" tone="amber" hint={t('metricContext.awaitingDecision')} />
    case 'kpi-agent-findings': {
      const parts: string[] = []
      if (data.agentFindingsProposals > 0) parts.push(t('metricContext.agentProposals', { count: data.agentFindingsProposals }))
      if (data.agentFindingsLastRun) {
        parts.push(t('metricContext.agentLastRun', {
          date: dateTime(new Date(data.agentFindingsLastRun), { dateStyle: 'medium' }),
        }))
      }
      return (
        <MetricTile
          icon={<Sparkles size={15} />}
          label={t('widgets.agentFindings')}
          value={String(data.agentFindingsOpen)}
          href="/agents"
          tone="violet"
          hint={parts.length > 0 ? parts.join(' · ') : t('metricContext.agentClear')}
        />
      )
    }
    case 'kpi-ledger-balance':
      if (data.baseCurrency === null) return withoutCurrency(t('widgets.ledgerBalance'), <Scale size={15} />, '/journal', 'slate')
      return <MetricTile icon={<Scale size={15} />} label={t('widgets.ledgerBalance')} value={money(data.ledgerSum, { currency: data.baseCurrency })} href="/journal" tone="slate" />
    case 'kpi-cash-balance':
      if (data.baseCurrency === null) return withoutCurrency(t('widgets.cashBalance'), <Landmark size={15} />, '/banking', 'emerald')
      return <MetricTile icon={<Landmark size={15} />} label={t('widgets.cashBalance')} value={money(data.cashBalance, { currency: data.baseCurrency })} href="/banking" tone="emerald" hint={withAsOf(t('metricContext.baseCurrency', { currency: data.baseCurrency }))} />
    case 'kpi-open-receivables': {
      if (data.baseCurrency === null) return withoutCurrency(t('widgets.openReceivables'), <CircleDollarSign size={15} />, '/ar', 'sky')
      // The withAsOf(outstanding) shape below: a money tile
      // must state its cut-off. The DSO qualifier appends after it, never
      // in place of it.
      const dso = data.receivablesDso === null ? '' : ` · ${t('metricContext.dso', { days: Math.round(data.receivablesDso) })}`
      return <MetricTile icon={<CircleDollarSign size={15} />} label={t('widgets.openReceivables')} value={money(data.openReceivables, { currency: data.baseCurrency })} href="/ar" tone="sky" hint={`${withAsOf(t('metricContext.outstanding'))}${dso}`} />
    }
    case 'kpi-overdue-receivables':
      if (data.baseCurrency === null) return withoutCurrency(t('widgets.overdueReceivables'), <AlertTriangle size={15} />, '/ar', 'rose')
      return <MetricTile icon={<AlertTriangle size={15} />} label={t('widgets.overdueReceivables')} value={money(data.overdueReceivables, { currency: data.baseCurrency })} href="/ar" tone="rose" hint={withAsOf(t('metricContext.pastDue'))} />
    case 'kpi-open-payables': {
      if (data.baseCurrency === null) return withoutCurrency(t('widgets.openPayables'), <Receipt size={15} />, '/ap', 'violet')
      // The withAsOf(outstanding) shape below: a money tile
      // must state its cut-off. The DPO qualifier appends after it, never
      // in place of it.
      const dpo = data.payablesDpo === null ? '' : ` · ${t('metricContext.dpo', { days: Math.round(data.payablesDpo) })}`
      return <MetricTile icon={<Receipt size={15} />} label={t('widgets.openPayables')} value={money(data.openPayables, { currency: data.baseCurrency })} href="/ap" tone="violet" hint={`${withAsOf(t('metricContext.outstanding'))}${dpo}`} />
    }
    case 'kpi-expected-receipts-30d':
      if (data.baseCurrency === null) return withoutCurrency(t('widgets.expectedReceipts'), <CalendarCheck size={15} />, '/ar', 'teal')
      return data.expectedReceipts30d === null
        ? <MetricTile icon={<CalendarCheck size={15} />} label={t('widgets.expectedReceipts')} value="—" href="/ar" tone="teal" hint={withAsOf(t('metricContext.noData'))} />
        : <MetricTile icon={<CalendarCheck size={15} />} label={t('widgets.expectedReceipts')} value={money(data.expectedReceipts30d, { currency: data.baseCurrency })} href="/ar" tone="teal" hint={withAsOf(t('metricContext.next30Days'))} />
    case 'kpi-bills-due-30d':
      if (data.baseCurrency === null) return withoutCurrency(t('widgets.expectedPayments'), <CalendarClock size={15} />, '/ap', 'amber')
      return data.expectedPayments30d === null
        ? <MetricTile icon={<CalendarClock size={15} />} label={t('widgets.expectedPayments')} value="—" href="/ap" tone="amber" hint={withAsOf(t('metricContext.noData'))} />
        : <MetricTile icon={<CalendarClock size={15} />} label={t('widgets.expectedPayments')} value={money(data.expectedPayments30d, { currency: data.baseCurrency })} href="/ap" tone="amber" hint={withAsOf(t('metricContext.next30Days'))} />
    case 'kpi-cash-runway': {
      // Status is tone as well as text: a shortfall reads rose before a
      // single word is parsed. The figure is the projected end — where cash
      // lands at the horizon — with the runway or the shortfall beneath it.
      const tone = data.runwayStatus === 'critical' ? 'rose' : data.runwayStatus === 'caution' ? 'amber' : 'emerald'
      if (data.baseCurrency === null) return withoutCurrency(t('widgets.runway'), <Hourglass size={15} />, '/banking/cash', tone)
      if (data.projectedCash === null) {
        return <MetricTile icon={<Hourglass size={15} />} label={t('widgets.runway')} value="—" href="/banking/cash" tone="emerald" hint={withAsOf(t('metricContext.noData'))} />
      }
      const state = data.runwayStatus === 'critical'
        ? `${t('metricContext.cashShortfall')} · ${t('metricContext.weekOf', { date: fmtDay(data.lowestCashWeek ?? data.asOfDate) })}`
        : data.runwayWeeks === null
          ? t('metricContext.noBurn')
          : t('metricContext.runwayWeeks', { weeks: displayWeeks(Number(data.runwayWeeks)) })
      return <MetricTile icon={<Hourglass size={15} />} label={t('widgets.runway')} value={money(data.projectedCash, { currency: data.baseCurrency })} href="/banking/cash" tone={tone} hint={withAsOf(state)} />
    }
    case 'kpi-overdue-payables':
      if (data.baseCurrency === null) return withoutCurrency(t('widgets.overduePayables'), <AlertTriangle size={15} />, '/ap', 'orange')
      return <MetricTile icon={<AlertTriangle size={15} />} label={t('widgets.overduePayables')} value={money(data.overduePayables, { currency: data.baseCurrency })} href="/ap" tone="orange" hint={withAsOf(t('metricContext.pastDue'))} />
    case 'kpi-revenue-mtd': {
      // Consolidated P&L tiles label the currency the reader returned and
      // the fiscal period it covered — never the org base or "Month to
      // date". A refused read names its remedy on the tile, never "No data".
      if (data.plUnavailable) {
        return <MetricTile icon={<TrendingUp size={15} />} label={t('widgets.revenue')} value="—" href="/reports/pnl" tone="emerald" hint={withAsOf(data.plUnavailable)} />
      }
      const revenueCcy = data.plCurrency ?? data.baseCurrency
      if (revenueCcy === null) return withoutCurrency(t('widgets.revenue'), <TrendingUp size={15} />, '/reports/pnl', 'emerald')
      return data.revenueMtd === null
        ? <MetricTile icon={<TrendingUp size={15} />} label={t('widgets.revenue')} value="—" href="/reports/pnl" tone="emerald" hint={withAsOf(t('metricContext.noData'))} />
        : <MetricTile icon={<TrendingUp size={15} />} label={t('widgets.revenue')} value={money(data.revenueMtd, { currency: revenueCcy })} href="/reports/pnl" tone="emerald" hint={withAsOf(plWindowHint(data.plPeriodLabel, data.plScopeLabel))} />
    }
    case 'kpi-expenses-mtd': {
      if (data.plUnavailable) {
        return <MetricTile icon={<Wallet size={15} />} label={t('widgets.operatingExpenses')} value="—" href="/reports/pnl" tone="amber" hint={withAsOf(data.plUnavailable)} />
      }
      const expensesCcy = data.plCurrency ?? data.baseCurrency
      if (expensesCcy === null) return withoutCurrency(t('widgets.operatingExpenses'), <Wallet size={15} />, '/reports/pnl', 'amber')
      return <MetricTile icon={<Wallet size={15} />} label={t('widgets.operatingExpenses')} value={data.expensesMtd === null ? '—' : money(data.expensesMtd, { currency: expensesCcy })} href="/reports/pnl" tone="amber" hint={withAsOf(data.expensesMtd === null ? t('metricContext.noData') : plWindowHint(data.plPeriodLabel, data.plScopeLabel))} />
    }
    case 'kpi-net-income-mtd': {
      if (data.plUnavailable) {
        return <MetricTile icon={<Wallet size={15} />} label={t('widgets.netIncome')} value="—" href="/reports/pnl" tone="teal" hint={withAsOf(data.plUnavailable)} />
      }
      const incomeCcy = data.plCurrency ?? data.baseCurrency
      if (incomeCcy === null) return withoutCurrency(t('widgets.netIncome'), <Wallet size={15} />, '/reports/pnl', 'teal')
      return data.netIncomeMtd === null
        ? <MetricTile icon={<Wallet size={15} />} label={t('widgets.netIncome')} value="—" href="/reports/pnl" tone="teal" hint={withAsOf(t('metricContext.noData'))} />
        : <MetricTile icon={<Wallet size={15} />} label={t('widgets.netIncome')} value={money(data.netIncomeMtd, { currency: incomeCcy })} href="/reports/pnl" tone="teal" hint={withAsOf(plWindowHint(data.plPeriodLabel, data.plScopeLabel))} />
    }
    case 'kpi-gross-margin-mtd': {
      if (data.plUnavailable) {
        return <MetricTile icon={<Percent size={15} />} label={t('widgets.grossMargin')} value="—" href="/reports/pnl" tone="slate" hint={withAsOf(data.plUnavailable)} />
      }
      const marginCcy = data.plCurrency ?? data.baseCurrency
      if (marginCcy === null) return withoutCurrency(t('widgets.grossMargin'), <Percent size={15} />, '/reports/pnl', 'slate')
      // No period revenue means the ratio is undefined, not zero — the tile
      // shows the gross profit it can state and drops the margin it cannot.
      const periodHint = plWindowHint(data.plPeriodLabel, data.plScopeLabel)
      const margin = data.grossMarginMtd === null
        ? null
        : number(Number(data.grossMarginMtd), { style: 'percent', maximumFractionDigits: 1 })
      const hint = margin === null ? periodHint : `${margin} · ${periodHint}`
      return data.grossProfitMtd === null
        ? <MetricTile icon={<Percent size={15} />} label={t('widgets.grossMargin')} value="—" href="/reports/pnl" tone="slate" hint={withAsOf(t('metricContext.noData'))} />
        : <MetricTile icon={<Percent size={15} />} label={t('widgets.grossMargin')} value={money(data.grossProfitMtd, { currency: marginCcy })} href="/reports/pnl" tone="slate" hint={withAsOf(hint)} />
    }
    case 'list-top-customers':
      return <PartyBalanceList title={t('widgets.topCustomers')} icon={<Users size={14} />} href="/ar" parties={data.topCustomers ?? []} />
    case 'list-top-vendors':
      return <PartyBalanceList title={t('widgets.topVendors')} icon={<Store size={14} />} href="/ap" parties={data.topVendors ?? []} />
    case 'kpi-items-to-reconcile':
      return (
        <MetricTile
          icon={<ListChecks size={15} />}
          label={t('widgets.itemsToReconcile')}
          value={String(data.unreconciledItems)}
          href="/banking/match"
          tone={data.unreconciledItems > 0 ? 'amber' : 'emerald'}
          hint={data.unreconciledItems > 0 ? t('metricContext.toReconcile') : t('metricContext.allMatched')}
        />
      )
    case 'kpi-expenses-awaiting-approval':
      return (
        <MetricTile
          icon={<Wallet size={15} />}
          label={t('widgets.expensesAwaitingApproval')}
          value={String(data.pendingExpenses)}
          href="/expenses"
          tone={data.pendingExpenses > 0 ? 'amber' : 'emerald'}
          hint={data.pendingExpenses > 0 ? t('metricContext.awaitingDecision') : t('metricContext.nonePending')}
        />
      )
    case 'resourcing-pulse': {
      const pulse = data.resourcingPulse
      if (pulse === null) return <PersonaEmpty title={t('widgets.resourcingPulse')} icon={<Users size={14} />} />
      return (
        <MetricTile
          icon={<Users size={15} />}
          label={t('widgets.resourcingPulse')}
          value={pulse.utilization ?? '—'}
          href="/resourcing"
          tone={pulse.overallocatedWeeks > 0 ? 'amber' : 'teal'}
          hint={t('metricContext.resourcingPulse', {
            bench: pulse.benchPeople,
            rolloffs: pulse.rolloffs,
            overallocated: pulse.overallocatedWeeks,
          })}
        />
      )
    }
    case 'list-recent-entries':
      return <RecentEntriesList entries={data.recentEntries} />
    case 'list-pending-approvals':
      return <PendingApprovalsList approvals={data.pendingApprovalList} href="/inbox?tab=all" />
    case 'personal-in-progress':
      return <InProgressList documents={data.draftDocuments} />
    case 'personal-inbox':
      return <PendingApprovalsList approvals={data.myApprovalList} title={t('widgets.myApprovals')} />
    // HR-15 persona-home tiles (readers in _persona.ts, registry in
    // _widget-registry.ts). Null data renders the honest empty card — a
    // tile with nothing true to say never renders a zero as a fact.
    case 'inbox-list':
      return <PersonaTaskList title={t('widgets.inboxList')} href="/inbox" items={data.inboxTasksTop} empty={t('persona.nothingWaiting')} />
    case 'team-approvals':
      return <PersonaTaskList title={t('widgets.teamApprovals')} href="/inbox?filter=approvals" items={data.inboxApprovalsTop} empty={t('persona.nothingWaiting')} />
    case 'pay-tile':
      return data.payTile === null
        ? <PersonaEmpty title={t('widgets.payTile')} icon={<Wallet size={14} />} />
        : <MetricTile icon={<Wallet size={15} />} label={t('widgets.payTile')} value={data.payTile.nextPayDate ?? '—'} href="/payroll" tone="emerald" hint={data.payTile.lastPayDate ? t('persona.lastSlip', { date: data.payTile.lastPayDate }) : undefined} />
    case 'balance-tile':
      return <PersonaRows title={t('widgets.balanceTile')} icon={<Hourglass size={14} />} href="/hrm/my-leave" actionLabel={t('persona.requestTimeOff')} rows={(data.balances ?? []).map((b) => ({ label: b.code, detail: b.hours }))} empty={t('persona.noBalances')} />
    case 'whos-out-strip':
      return <PersonaRows title={t('widgets.whosOut')} icon={<Users size={14} />} rows={(data.whosOut ?? []).map((w) => ({ label: w.name, detail: w.range }))} empty={t('persona.nobodyOut')} />
    case 'home-upcoming':
      return <PersonaRows title={t('widgets.homeUpcoming')} icon={<CalendarClock size={14} />} rows={(data.upcoming ?? []).map((u) => ({ label: u.label, detail: u.date, href: u.href }))} empty={t('persona.nothingUpcoming')} />
    case 'celebrations-list':
      return <PersonaRows title={t('widgets.celebrations')} icon={<Sparkles size={14} />} rows={(data.celebrations ?? []).map((c) => ({ label: c.name, detail: c.detail }))} empty={t('persona.noCelebrations')} />
    case 'announcements-card':
      return <PersonaRows title={t('widgets.announcements')} icon={<NotebookPen size={14} />} rows={(data.announcements ?? []).map((a) => ({ label: a.title, detail: a.body }))} empty={t('persona.noAnnouncements')} />
    case 'home-ask':
      return (
        <CardShell title={t('widgets.homeAsk')} icon={<Sparkles size={14} />} href="/assistant">
          <div className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">{t('persona.askHint')}</div>
        </CardShell>
      )
    case 'team-steps':
      return <PersonaRows title={t('widgets.teamSteps')} icon={<ListChecks size={14} />} href="/hrm/processes" rows={(data.teamSteps ?? []).map((s) => ({ label: s.title, detail: `${s.owner} · ${s.due}` }))} empty={t('persona.noOverdueSteps')} />
    case 'team-nudges':
      return <PersonaRows title={t('widgets.teamNudges')} icon={<AlertTriangle size={14} />} rows={(data.teamNudges ?? []).map((n) => ({ label: n.text, href: n.href }))} empty={t('persona.noNudges')} />
    case 'team-headcount':
      return data.teamHeadcount === null
        ? <PersonaEmpty title={t('widgets.teamHeadcount')} icon={<Users size={14} />} />
        : <MetricTile icon={<Users size={15} />} label={t('widgets.teamHeadcount')} value={String(data.teamHeadcount)} href="/hrm" tone="teal" />
    case 'team-quals':
      // Until the qualification source exists the tile refuses by name — it
      // must never assert "No expiring qualifications" without reading
      // anything. With a source, an empty roster honestly reports none.
      return data.teamQuals === null
        ? <PersonaRows title={t('widgets.teamQuals')} icon={<BookOpen size={14} />} href="/hrm" rows={[]} empty={t('persona.unavailable')} />
        : <PersonaRows title={t('widgets.teamQuals')} icon={<BookOpen size={14} />} href="/hrm" rows={data.teamQuals.map((q) => ({ label: q.name, detail: q.detail }))} empty={t('persona.noExpiringQuals')} />
    case 'admin-attention':
      return <PersonaRows title={t('widgets.adminAttention')} icon={<AlertTriangle size={14} />} rows={(data.adminAttention ?? []).map((a) => ({ label: a.label, detail: a.reason ?? (a.unavailable ? t('persona.unavailable') : String(a.count)), href: a.href }))} empty={t('persona.allClear')} />
    case 'workflow-errors':
      return data.workflowErrors === null
        ? <PersonaEmpty title={t('widgets.workflowErrors')} icon={<Activity size={14} />} />
        : <MetricTile icon={<Activity size={15} />} label={t('widgets.workflowErrors')} value={data.workflowErrors.unavailable ? t('persona.unavailable') : String(data.workflowErrors.count)} href="/admin/flows" tone={data.workflowErrors.unavailable ? 'amber' : data.workflowErrors.count > 0 ? 'rose' : 'emerald'} hint={data.workflowErrors.unavailable ? t('persona.unavailable') : (data.workflowErrors.count > 0 ? t('persona.needsAttention') : t('persona.allClear'))} />
    case 'admin-calendar':
      return <PersonaRows title={t('widgets.adminCalendar')} icon={<CalendarClock size={14} />} rows={(data.adminCalendar ?? []).map((c) => ({ label: c.label, detail: c.date }))} empty={t('persona.nothingUpcoming')} />
    case 'list-close-readiness':
      return <CloseReadinessList runs={data.closeRuns} unavailable={data.closeRunsUnavailable} />
    default:
      return (
        <CardShell title={widgetId}>
          <EmptyRow />
        </CardShell>
      )
  }
}

/**
 * HR-15 persona render helpers. Every tile links where its rows live — a
 * tile with no rows renders the honest empty card, never a zero as a fact.
 */
function PersonaEmpty({ title, icon }: { title: string; icon?: React.ReactNode }) {
  return (
    <CardShell title={title} icon={icon}>
      <EmptyRow />
    </CardShell>
  )
}

function PersonaRows({
  title,
  icon,
  href,
  actionLabel,
  rows,
  empty,
}: {
  title: string
  icon?: React.ReactNode
  href?: string
  actionLabel?: string
  rows: { label: string; detail?: string | null; href?: string }[]
  empty: string
}) {
  if (rows.length === 0) {
    return (
      <CardShell title={title} icon={icon} href={href}>
        <div className="flex h-full items-center justify-center px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
          {empty}
        </div>
      </CardShell>
    )
  }
  return (
    <CardShell title={title} icon={icon} href={href}>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {rows.map((row, index) => {
          const body = (
            <>
              <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{row.label}</div>
              {row.detail ? (
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">{row.detail}</div>
              ) : null}
            </>
          )
          return (
            <li key={index} className="px-4 py-2.5">
              {row.href ? (
                <Link href={row.href as never} className="block transition hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  {body}
                </Link>
              ) : (
                body
              )}
            </li>
          )
        })}
      </ul>
      {actionLabel && href ? (
        <div className="border-t border-slate-100 px-4 py-2 dark:border-slate-800">
          <Link href={href as never} className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
            {actionLabel}
          </Link>
        </div>
      ) : null}
    </CardShell>
  )
}

function PersonaTaskList({
  title,
  href,
  items,
  empty,
}: {
  title: string
  href: string
  items: DashboardMetrics['inboxTasksTop']
  empty: string
}) {
  if (!items || items.length === 0) {
    return (
      <CardShell title={title} icon={<ClipboardList size={14} />} href={href}>
        <div className="flex h-full items-center justify-center px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
          {empty}
        </div>
      </CardShell>
    )
  }
  return (
    <CardShell title={title} icon={<ClipboardList size={14} />} href={href}>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={item.href as never}
              className="block px-4 py-2.5 transition hover:bg-slate-50 dark:hover:bg-slate-800/40"
            >
              <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{item.title}</div>
              {item.subtitle ? (
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">{item.subtitle}</div>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </CardShell>
  )
}

function RecentEntriesList({
  entries,
}: {
  entries: DashboardMetrics['recentEntries']
}) {
  const { date } = useViewerFormat()
  const { money } = useMoney()
  const t = useTranslations('dashboard')
  // The loader only emits posted/reversed rows; anything else renders raw
  // rather than guessing a translation.
  const statusLabel = (status: string) =>
    status === 'posted'
      ? t('widgets.recentEntryStatusPosted')
      : status === 'reversed'
        ? t('widgets.recentEntryStatusReversed')
        : status
  if (entries.length === 0) {
    return (
      <CardShell title={t('widgets.recentEntries')} icon={<NotebookPen size={14} />}>
        <EmptyRow />
      </CardShell>
    )
  }
  return (
    <CardShell title={t('widgets.recentEntries')} icon={<NotebookPen size={14} />} href="/journal">
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {entries.map((e) => (
          <li key={e.id}>
            <Link
              // The posted-entry route resolves every origin to the drawer
              // that owns it (source-document, journal, or txn drawer).
              // ?entry= drives the manual-journal drawer over DOCUMENT ids
              // only, so entry ids linked there opened nothing.
              href={`/journal?journalEntry=${e.id}`}
              className="flex items-center justify-between gap-2 px-4 py-2.5 transition hover:bg-slate-50 dark:hover:bg-slate-800/40"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                    {e.entryNumber ?? '—'}
                  </span>
                  <Badge variant={e.status === 'posted' ? 'success' : 'outline'}>
                    {statusLabel(e.status)}
                  </Badge>
                </div>
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {e.memo ?? '—'} · {date(new Date(`${e.postingDate}T12:00:00Z`))}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
                  {money(e.totalDebits, { currency: e.currency ?? undefined })}
                </div>
                <div className="text-xs text-slate-400 dark:text-slate-500">
                  {t('widgets.recentEntryLines', { count: e.lineCount })}
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </CardShell>
  )
}

function PendingApprovalsList({
  approvals,
  title,
  href = '/inbox',
}: {
  approvals: DashboardMetrics['pendingApprovalList']
  title?: string
  href?: string
}) {
  const { date } = useViewerFormat()
  const { money } = useMoney()
  const t = useTranslations('dashboard')
  const ta = useTranslations('approvals')
  // Unknown kinds render as their code: replacing underscores guesses
  // English for a kind the catalog never translated.
  const kindLabel = (kind: string) =>
    ta.has(`kinds.${kind}` as never) ? ta(`kinds.${kind}` as never) : kind
  if (approvals.length === 0) {
    return (
      <CardShell title={title ?? t('widgets.pendingApprovalsList')} icon={<ClipboardList size={14} />}>
        <EmptyRow />
      </CardShell>
    )
  }
  return (
    <CardShell title={title ?? t('widgets.pendingApprovalsList')} icon={<ClipboardList size={14} />} href={href}>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {approvals.map((a) => (
          <li key={a.id}>
            <Link
              // Each row deep-links to its record through the shared approvals
              // resolver, computed on the server (the same href the inbox row
              // uses). Kinds with no module surface keep the generic list href.
              href={a.href ?? href}
              className="flex items-center justify-between gap-2 px-4 py-2.5 transition hover:bg-slate-50 dark:hover:bg-slate-800/40"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium capitalize text-slate-800 dark:text-slate-100">
                    {kindLabel(a.targetKind)}
                  </span>
                  {a.title ? <Badge variant="warning">{a.title}</Badge> : null}
                </div>
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {date(new Date(a.createdAt))}
                </div>
              </div>
              {a.amount ? (
                <div className="shrink-0 text-right text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
                  {money(a.amount, { currency: a.currency ?? undefined })}
                </div>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </CardShell>
  )
}

/**
 * Top balances by party — the same rollup rows the AR/AP cockpits list.
 * An empty book renders the empty card, never a zero row.
 */
function PartyBalanceList({
  title,
  icon,
  href,
  parties,
}: {
  title: string
  icon: React.ReactNode
  href: string
  parties: Array<{ partyId: string | null; partyName: string; amount: string; count: number; overdue: string }>
}) {
  const { money } = useMoney()
  const t = useTranslations('dashboard')
  if (parties.length === 0) {
    return (
      <CardShell title={title} icon={icon}>
        <EmptyRow />
      </CardShell>
    )
  }
  return (
    <CardShell title={title} icon={icon} href={href}>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {parties.map((p) => (
          <li key={p.partyId ?? p.partyName}>
            <div className="flex items-center justify-between gap-2 px-4 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                    {p.partyName}
                  </span>
                  <Badge variant="outline">{t('widgets.openCount', { count: p.count })}</Badge>
                </div>
                {compareMoney(p.overdue, '0') > 0 ? (
                  <div className="truncate text-xs text-rose-600 dark:text-rose-400">
                    {money(p.overdue)} · {t('metricContext.pastDue')}
                  </div>
                ) : null}
              </div>
              <div className="shrink-0 text-right text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
                {money(p.amount)}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </CardShell>
  )
}

function CloseReadinessList({
  runs,
  unavailable,
}: {
  runs: DashboardMetrics['closeRuns']
  unavailable: DashboardMetrics['closeRunsUnavailable']
}) {
  const { date } = useViewerFormat()
  const t = useTranslations('dashboard')
  const tc = useTranslations('close')
  // Canonical workspace labels; an unknown status/stage renders raw rather
  // than guessing a translation, as with recent entries above.
  const statusLabel = (status: string) =>
    tc.has(`runStatus.${status}` as never) ? tc(`runStatus.${status}` as never) : status
  const stageLabel = (stage: string | null) =>
    stage === null ? null : tc.has(`stages.${stage}` as never) ? tc(`stages.${stage}` as never) : stage
  const statusVariant = (status: string): 'success' | 'warning' | 'outline' =>
    status === 'closed' || status === 'published'
      ? 'success'
      : status === 'in_progress' || status === 'review'
        ? 'warning'
        : 'outline'
  if (unavailable) {
    return (
      <CardShell title={t('widgets.closeReadiness')} icon={<CalendarCheck size={14} />} href="/close">
        <div className="flex h-full flex-col items-center justify-center gap-1 px-4 py-6 text-center">
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {unavailable}
          </span>
        </div>
      </CardShell>
    )
  }
  if (runs.length === 0) {
    return (
      <CardShell title={t('widgets.closeReadiness')} icon={<CalendarCheck size={14} />} href="/close">
        <div className="flex h-full flex-col items-center justify-center gap-1 py-6 text-center">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
            {t('widgets.closeReadinessEmpty')}
          </span>
          <span className="px-4 text-xs text-slate-400 dark:text-slate-500">
            {t('catalog.closeReadiness')}
          </span>
        </div>
      </CardShell>
    )
  }
  return (
    <CardShell title={t('widgets.closeReadiness')} icon={<CalendarCheck size={14} />} href="/close">
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {runs.map((r) => {
          const stage = stageLabel(r.stage)
          return (
            <li key={r.id}>
              <Link
                href="/close"
                className="flex items-center justify-between gap-2 px-4 py-2.5 transition hover:bg-slate-50 dark:hover:bg-slate-800/40"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                      {r.period}
                    </span>
                    <Badge variant={statusVariant(r.status)}>{statusLabel(r.status)}</Badge>
                  </div>
                  <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {r.book}
                    {stage ? ` · ${stage}` : null}
                    {r.targetCloseDate ? ` · ${date(new Date(`${r.targetCloseDate}T12:00:00Z`), { timeZone: 'UTC' })}` : null}
                  </div>
                </div>
              </Link>
            </li>
          )
        })}
      </ul>
    </CardShell>
  )
}

function InProgressList({
  documents,
}: {
  documents: DashboardMetrics['draftDocuments']
}) {
  const { date } = useViewerFormat()
  const { money } = useMoney()
  const t = useTranslations('dashboard')
  const ta = useTranslations('approvals')
  // Unknown kinds render as their code: replacing underscores guesses
  // English for a kind the catalog never translated.
  const kindLabel = (kind: string) =>
    ta.has(`kinds.${kind}` as never) ? ta(`kinds.${kind}` as never) : kind
  if (documents.length === 0) {
    return (
      <CardShell title={t('widgets.inProgress')} icon={<FileText size={14} />}>
        <EmptyRow />
      </CardShell>
    )
  }
  return (
    <CardShell title={t('widgets.inProgress')} icon={<FileText size={14} />}>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {documents.map((d) => (
          <li key={d.id}>
            <Link
              href={`/${d.kind === 'vendor_bill' ? 'ap' : d.kind === 'customer_invoice' ? 'ar' : 'journal'}?doc=${d.id}`}
              className="flex items-center justify-between gap-2 px-4 py-2.5 transition hover:bg-slate-50 dark:hover:bg-slate-800/40"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                    {d.documentNumber}
                  </span>
                  <Badge variant="outline" className="capitalize">{kindLabel(d.kind)}</Badge>
                </div>
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {d.documentDate ? date(new Date(`${d.documentDate}T12:00:00Z`)) : '—'}
                </div>
              </div>
              <div className="shrink-0 text-right text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
                {money(d.total, { currency: d.currency })}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </CardShell>
  )
}

/**
 * The editor's stand-in for an analytics widget not yet on the layout: its
 * name and a plain statement of when the figures appear. Its dashboard's
 * loaders run once the layout is saved.
 */
export function AnalyticsWidgetPreview({ widgetId }: { widgetId: string }) {
  const t = useTranslations('dashboard')
  const meta = WIDGETS[widgetId]
  return (
    <CardShell title={meta ? t(meta.labelKey) : widgetId}>
      <div className="flex h-full items-center justify-center px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
        {t('grid.analyticsPreview')}
      </div>
    </CardShell>
  )
}
