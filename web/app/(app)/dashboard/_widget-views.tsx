'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { useMoney } from '@/components/money-provider'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import {
  ArrowUpRight,
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
import { metricTilePack, packsEqual } from './_metric-tile-density'
import type { DashboardMetrics } from './_metrics'

export function WidgetCard({
  widgetId,
  data,
}: {
  widgetId: string
  data: DashboardMetrics
}) {
  const { money } = useMoney()
  const t = useTranslations('dashboard')
  const locale = useLocale()
  // The cut-off the as-of readers used, so a tile that excludes
  // future-dated documents says which day it is cut at (F-t02-007).
  // Noon-anchored: a bare YYYY-MM-DD parses as UTC midnight and would
  // render a day early west of Greenwich.
  const asOf = data.asOfDate
    ? t('metricContext.asOf', {
        date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
          new Date(`${data.asOfDate}T12:00:00Z`),
        ),
      })
    : null
  const withAsOf = (hint: string) => (asOf ? `${hint} · ${asOf}` : hint)
  // Noon-anchored like the as-of label above: a bare YYYY-MM-DD parses as
  // UTC midnight and would render a day early west of Greenwich.
  const fmtDay = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(`${iso}T12:00:00Z`))
  // Runway weeks read whole past ten, one decimal below — the precise
  // figure lives behind the tile's link on the banking page.
  const displayWeeks = (weeks: number) => (weeks >= 10 ? Math.round(weeks) : Math.round(weeks * 10) / 10)

  switch (widgetId) {
    case 'kpi-journal-lines':
      return <MetricTile icon={<BookOpen size={15} />} label={t('widgets.journalLines')} value={String(data.journalLineCount)} href="/journal" tone="teal" />
    case 'kpi-accounts-active':
      return <MetricTile icon={<Layers size={15} />} label={t('widgets.activeAccounts')} value={String(data.accountCount)} href="/accounts" tone="sky" />
    case 'kpi-entries-today':
      return <MetricTile icon={<FileText size={15} />} label={t('widgets.entriesToday')} value={String(data.entriesToday)} href="/journal" tone="teal" hint={t('metricContext.today')} />
    case 'kpi-pending-approvals':
      return <MetricTile icon={<ClipboardList size={15} />} label={t('widgets.pendingApprovals')} value={String(data.pendingApprovals)} href="/approvals?tab=all" tone="amber" hint={t('metricContext.awaitingDecision')} />
    case 'kpi-agent-findings': {
      const parts: string[] = []
      if (data.agentFindingsProposals > 0) parts.push(t('metricContext.agentProposals', { count: data.agentFindingsProposals }))
      if (data.agentFindingsLastRun) {
        parts.push(t('metricContext.agentLastRun', {
          date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(data.agentFindingsLastRun)),
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
      return <MetricTile icon={<Scale size={15} />} label={t('widgets.ledgerBalance')} value={money(data.ledgerSum, { currency: data.baseCurrency })} href="/journal" tone="slate" />
    case 'kpi-cash-balance':
      return <MetricTile icon={<Landmark size={15} />} label={t('widgets.cashBalance')} value={money(data.cashBalance, { currency: data.baseCurrency })} href="/banking" tone="emerald" hint={withAsOf(t('metricContext.baseCurrency', { currency: data.baseCurrency }))} />
    case 'kpi-open-receivables': {
      // F-t02-007 pins the withAsOf(outstanding) shape below: a money tile
      // must state its cut-off. The DSO qualifier appends after it, never
      // in place of it.
      const dso = data.receivablesDso === null ? '' : ` · ${t('metricContext.dso', { days: Math.round(data.receivablesDso) })}`
      return <MetricTile icon={<CircleDollarSign size={15} />} label={t('widgets.openReceivables')} value={money(data.openReceivables, { currency: data.baseCurrency })} href="/ar" tone="sky" hint={`${withAsOf(t('metricContext.outstanding'))}${dso}`} />
    }
    case 'kpi-overdue-receivables':
      return <MetricTile icon={<AlertTriangle size={15} />} label={t('widgets.overdueReceivables')} value={money(data.overdueReceivables, { currency: data.baseCurrency })} href="/ar" tone="rose" hint={withAsOf(t('metricContext.pastDue'))} />
    case 'kpi-open-payables': {
      // F-t02-007 pins the withAsOf(outstanding) shape below: a money tile
      // must state its cut-off. The DPO qualifier appends after it, never
      // in place of it.
      const dpo = data.payablesDpo === null ? '' : ` · ${t('metricContext.dpo', { days: Math.round(data.payablesDpo) })}`
      return <MetricTile icon={<Receipt size={15} />} label={t('widgets.openPayables')} value={money(data.openPayables, { currency: data.baseCurrency })} href="/ap" tone="violet" hint={`${withAsOf(t('metricContext.outstanding'))}${dpo}`} />
    }
    case 'kpi-expected-receipts-30d':
      return data.expectedReceipts30d === null
        ? <MetricTile icon={<CalendarCheck size={15} />} label={t('widgets.expectedReceipts')} value="—" href="/ar" tone="teal" hint={withAsOf(t('metricContext.noData'))} />
        : <MetricTile icon={<CalendarCheck size={15} />} label={t('widgets.expectedReceipts')} value={money(data.expectedReceipts30d, { currency: data.baseCurrency })} href="/ar" tone="teal" hint={withAsOf(t('metricContext.next30Days'))} />
    case 'kpi-bills-due-30d':
      return data.expectedPayments30d === null
        ? <MetricTile icon={<CalendarClock size={15} />} label={t('widgets.expectedPayments')} value="—" href="/ap" tone="amber" hint={withAsOf(t('metricContext.noData'))} />
        : <MetricTile icon={<CalendarClock size={15} />} label={t('widgets.expectedPayments')} value={money(data.expectedPayments30d, { currency: data.baseCurrency })} href="/ap" tone="amber" hint={withAsOf(t('metricContext.next30Days'))} />
    case 'kpi-cash-runway': {
      // Status is tone as well as text: a shortfall reads rose before a
      // single word is parsed. The figure is the projected end — where cash
      // lands at the horizon — with the runway or the shortfall beneath it.
      const tone = data.runwayStatus === 'critical' ? 'rose' : data.runwayStatus === 'caution' ? 'amber' : 'emerald'
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
      return <MetricTile icon={<AlertTriangle size={15} />} label={t('widgets.overduePayables')} value={money(data.overduePayables, { currency: data.baseCurrency })} href="/ap" tone="orange" hint={withAsOf(t('metricContext.pastDue'))} />
    case 'kpi-revenue-mtd':
      return data.revenueMtd === null
        ? <MetricTile icon={<TrendingUp size={15} />} label={t('widgets.revenue')} value="—" href="/reports/pnl" tone="emerald" hint={withAsOf(t('metricContext.noData'))} />
        : <MetricTile icon={<TrendingUp size={15} />} label={t('widgets.revenue')} value={money(data.revenueMtd, { currency: data.baseCurrency })} href="/reports/pnl" tone="emerald" hint={withAsOf(t('metricContext.monthToDate'))} />
    case 'kpi-net-income-mtd':
      return data.netIncomeMtd === null
        ? <MetricTile icon={<Wallet size={15} />} label={t('widgets.netIncome')} value="—" href="/reports/pnl" tone="teal" hint={withAsOf(t('metricContext.noData'))} />
        : <MetricTile icon={<Wallet size={15} />} label={t('widgets.netIncome')} value={money(data.netIncomeMtd, { currency: data.baseCurrency })} href="/reports/pnl" tone="teal" hint={withAsOf(t('metricContext.monthToDate'))} />
    case 'kpi-gross-margin-mtd': {
      // No MTD revenue means the ratio is undefined, not zero — the tile
      // shows the gross profit it can state and drops the margin it cannot.
      const margin = data.grossMarginMtd === null
        ? null
        : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(Number(data.grossMarginMtd))
      const hint = margin === null ? t('metricContext.monthToDate') : `${margin} · ${t('metricContext.monthToDate')}`
      return data.grossProfitMtd === null
        ? <MetricTile icon={<Percent size={15} />} label={t('widgets.grossMargin')} value="—" href="/reports/pnl" tone="slate" hint={withAsOf(t('metricContext.noData'))} />
        : <MetricTile icon={<Percent size={15} />} label={t('widgets.grossMargin')} value={money(data.grossProfitMtd, { currency: data.baseCurrency })} href="/reports/pnl" tone="slate" hint={withAsOf(hint)} />
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
    case 'list-recent-entries':
      return <RecentEntriesList entries={data.recentEntries} />
    case 'list-pending-approvals':
      return <PendingApprovalsList approvals={data.pendingApprovalList} href="/approvals?tab=all" />
    case 'personal-in-progress':
      return <InProgressList documents={data.draftDocuments} />
    case 'personal-inbox':
      return <PendingApprovalsList approvals={data.myApprovalList} title={t('widgets.myApprovals')} />
    default:
      return (
        <CardShell title={widgetId}>
          <EmptyRow />
        </CardShell>
      )
  }
}

function CardShell({
  title,
  icon,
  href,
  children,
}: {
  title: string
  icon?: React.ReactNode
  href?: string
  children: React.ReactNode
}) {
  const header = (
    <div className="flex items-center gap-2.5 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
      {icon ? (
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-teal-50 text-teal-700 ring-1 ring-teal-100 ring-inset dark:bg-teal-950/50 dark:text-teal-300">
          {icon}
        </span>
      ) : null}
      <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
    </div>
  )
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      {href ? <Link href={href}>{header}</Link> : header}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </div>
  )
}

type MetricTone = 'teal' | 'sky' | 'emerald' | 'amber' | 'orange' | 'rose' | 'violet' | 'slate'

const METRIC_TONES: Record<MetricTone, { icon: string; accent: string; wash: string; hover: string; dot: string }> = {
  teal: { icon: 'bg-teal-500/10 text-teal-700 dark:bg-teal-400/10 dark:text-teal-300', accent: 'from-teal-500 to-cyan-400', wash: 'from-teal-500/[0.07]', hover: 'hover:border-teal-300/80 dark:hover:border-teal-700/70', dot: 'bg-teal-500' },
  sky: { icon: 'bg-sky-500/10 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300', accent: 'from-sky-500 to-indigo-400', wash: 'from-sky-500/[0.07]', hover: 'hover:border-sky-300/80 dark:hover:border-sky-700/70', dot: 'bg-sky-500' },
  emerald: { icon: 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300', accent: 'from-emerald-500 to-teal-400', wash: 'from-emerald-500/[0.07]', hover: 'hover:border-emerald-300/80 dark:hover:border-emerald-700/70', dot: 'bg-emerald-500' },
  amber: { icon: 'bg-amber-500/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300', accent: 'from-amber-500 to-yellow-400', wash: 'from-amber-500/[0.08]', hover: 'hover:border-amber-300/80 dark:hover:border-amber-700/70', dot: 'bg-amber-500' },
  orange: { icon: 'bg-orange-500/10 text-orange-700 dark:bg-orange-400/10 dark:text-orange-300', accent: 'from-orange-500 to-amber-400', wash: 'from-orange-500/[0.08]', hover: 'hover:border-orange-300/80 dark:hover:border-orange-700/70', dot: 'bg-orange-500' },
  rose: { icon: 'bg-rose-500/10 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300', accent: 'from-rose-500 to-pink-400', wash: 'from-rose-500/[0.07]', hover: 'hover:border-rose-300/80 dark:hover:border-rose-700/70', dot: 'bg-rose-500' },
  violet: { icon: 'bg-violet-500/10 text-violet-700 dark:bg-violet-400/10 dark:text-violet-300', accent: 'from-violet-500 to-fuchsia-400', wash: 'from-violet-500/[0.07]', hover: 'hover:border-violet-300/80 dark:hover:border-violet-700/70', dot: 'bg-violet-500' },
  slate: { icon: 'bg-slate-500/10 text-slate-700 dark:bg-slate-400/10 dark:text-slate-300', accent: 'from-slate-500 to-slate-300', wash: 'from-slate-500/[0.06]', hover: 'hover:border-slate-300 dark:hover:border-slate-600', dot: 'bg-slate-400' },
}

function useMetricTilePack() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pack, setPack] = useState(() => metricTilePack(0, 0))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const next = metricTilePack(el.clientWidth, el.clientHeight)
      setPack((prev) => (packsEqual(prev, next) ? prev : next))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, pack }
}

/**
 * KPI card. The tone lives INSIDE the rounded shape: a soft corner wash
 * behind the number, a tinted icon, and a short gradient accent stroke under
 * the value. No edge rails — a rail drawn on an absolutely positioned strip
 * cannot follow a rounded corner and reads as a print artifact.
 */
function MetricTile({
  icon,
  label,
  value,
  href,
  hint,
  tone,
}: {
  icon: React.ReactNode
  label: string
  value: string
  href?: string
  hint?: string
  tone: MetricTone
}) {
  const colors = METRIC_TONES[tone]
  const { ref, pack } = useMetricTilePack()
  const inner = (
    <div
      ref={ref}
      className="relative flex h-full min-h-[7rem] flex-col overflow-hidden rounded-2xl"
      style={{ padding: `${pack.padTop}px ${pack.padX}px ${pack.padBottom}px` }}
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-0 bg-gradient-to-br via-transparent to-transparent ${colors.wash}`}
      />
      <div className="relative flex items-center gap-2.5">
        <span
          className={`inline-flex shrink-0 items-center justify-center rounded-xl ${colors.icon}`}
          style={{ width: pack.icon, height: pack.icon }}
        >
          {icon}
        </span>
        <span className="min-w-0 truncate text-[12.5px] font-medium tracking-tight text-slate-600 dark:text-slate-300">
          {label}
        </span>
        {href ? (
          <span className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-300 opacity-0 transition-all duration-200 group-hover:opacity-100 dark:text-slate-600">
            <ArrowUpRight size={14} />
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1" aria-hidden />
      <div className="relative min-w-0">
        <div
          className="truncate leading-none font-semibold tracking-tight text-slate-950 tabular-nums dark:text-white"
          style={{ fontSize: pack.figure }}
        >
          {value}
        </div>
        <div className="flex items-center gap-2" style={{ marginTop: pack.hintGap }}>
          {pack.narrow ? null : (
            <span aria-hidden className={`h-[3px] w-8 shrink-0 rounded-full bg-gradient-to-r ${colors.accent}`} />
          )}
          {hint ? (
            <span
              className={`min-w-0 text-[11px] font-medium text-slate-400 dark:text-slate-500 ${
                pack.hintLines > 1 ? 'line-clamp-2 leading-snug' : 'truncate leading-none'
              }`}
            >
              {hint}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
  const shell = `group block h-full rounded-2xl border border-slate-200/90 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-200 dark:border-slate-800 dark:bg-slate-900`
  if (href) {
    return (
      <Link href={href} className={`${shell} hover:-translate-y-0.5 hover:shadow-[0_10px_30px_-12px_rgba(15,23,42,0.18)] ${colors.hover}`}>
        {inner}
      </Link>
    )
  }
  return <div className={shell}>{inner}</div>
}

function EmptyRow() {
  return (
    <div className="flex h-full items-center justify-center py-6 text-sm text-slate-400 dark:text-slate-500">
      —
    </div>
  )
}

function RecentEntriesList({
  entries,
}: {
  entries: DashboardMetrics['recentEntries']
}) {
  const { money } = useMoney()
  const t = useTranslations('dashboard')
  // The loader only emits posted/reversed rows; anything else renders raw
  // rather than guessing a translation (F-t01-009).
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
              // only, so entry ids linked there opened nothing (F-t06-005).
              href={`/journal/${e.id}`}
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
                  {e.memo ?? '—'} · {e.postingDate}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
                  {money(e.totalDebits)}
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
  href = '/approvals',
}: {
  approvals: DashboardMetrics['pendingApprovalList']
  title?: string
  href?: string
}) {
  const { money } = useMoney()
  const t = useTranslations('dashboard')
  const ta = useTranslations('approvals')
  const kindLabel = (kind: string) =>
    ta.has(`kinds.${kind}` as never) ? ta(`kinds.${kind}` as never) : kind.replace(/_/g, ' ')
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
              href={href}
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
                  {new Date(a.createdAt).toLocaleDateString()}
                </div>
              </div>
              {a.amount ? (
                <div className="shrink-0 text-right text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
                  {money(a.amount)}
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
                {Number(p.overdue) > 0 ? (
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

function InProgressList({
  documents,
}: {
  documents: DashboardMetrics['draftDocuments']
}) {
  const { money } = useMoney()
  const t = useTranslations('dashboard')
  const ta = useTranslations('approvals')
  const kindLabel = (kind: string) =>
    ta.has(`kinds.${kind}` as never) ? ta(`kinds.${kind}` as never) : kind.replace(/_/g, ' ')
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
                  {d.documentDate}
                </div>
              </div>
              <div className="shrink-0 text-right text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
                {money(d.total)}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </CardShell>
  )
}
