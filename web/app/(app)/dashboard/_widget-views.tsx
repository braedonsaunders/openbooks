'use client'

import { useMoney } from '@/components/money-provider'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  ArrowUpRight,
  AlertTriangle,
  BookOpen,
  CircleDollarSign,
  ClipboardList,
  FileText,
  Landmark,
  Layers,
  NotebookPen,
  Receipt,
  Scale,
} from 'lucide-react'
import { Badge } from '@openbooks/ui'
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

  switch (widgetId) {
    case 'kpi-journal-lines':
      return <MetricTile icon={<BookOpen size={15} />} label={t('widgets.journalLines')} value={String(data.journalLineCount)} href="/journal" tone="teal" />
    case 'kpi-accounts-active':
      return <MetricTile icon={<Layers size={15} />} label={t('widgets.activeAccounts')} value={String(data.accountCount)} href="/accounts" tone="sky" />
    case 'kpi-entries-today':
      return <MetricTile icon={<FileText size={15} />} label={t('widgets.entriesToday')} value={String(data.entriesToday)} href="/journal" tone="teal" hint={t('metricContext.today')} />
    case 'kpi-pending-approvals':
      return <MetricTile icon={<ClipboardList size={15} />} label={t('widgets.pendingApprovals')} value={String(data.pendingApprovals)} href="/approvals?tab=all" tone="amber" hint={t('metricContext.awaitingDecision')} />
    case 'kpi-ledger-balance':
      return <MetricTile icon={<Scale size={15} />} label={t('widgets.ledgerBalance')} value={money(data.ledgerSum, { currency: data.baseCurrency })} href="/journal" tone="slate" />
    case 'kpi-cash-balance':
      return <MetricTile icon={<Landmark size={15} />} label={t('widgets.cashBalance')} value={money(data.cashBalance, { currency: data.baseCurrency })} href="/banking" tone="emerald" hint={t('metricContext.baseCurrency', { currency: data.baseCurrency })} />
    case 'kpi-open-receivables':
      return <MetricTile icon={<CircleDollarSign size={15} />} label={t('widgets.openReceivables')} value={money(data.openReceivables, { currency: data.baseCurrency })} href="/ar" tone="sky" hint={t('metricContext.outstanding')} />
    case 'kpi-overdue-receivables':
      return <MetricTile icon={<AlertTriangle size={15} />} label={t('widgets.overdueReceivables')} value={money(data.overdueReceivables, { currency: data.baseCurrency })} href="/ar" tone="rose" hint={t('metricContext.pastDue')} />
    case 'kpi-open-payables':
      return <MetricTile icon={<Receipt size={15} />} label={t('widgets.openPayables')} value={money(data.openPayables, { currency: data.baseCurrency })} href="/ap" tone="violet" hint={t('metricContext.outstanding')} />
    case 'kpi-overdue-payables':
      return <MetricTile icon={<AlertTriangle size={15} />} label={t('widgets.overduePayables')} value={money(data.overduePayables, { currency: data.baseCurrency })} href="/ap" tone="orange" hint={t('metricContext.pastDue')} />
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
  const inner = (
    <div className="relative flex h-full flex-col overflow-hidden rounded-2xl">
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-0 bg-gradient-to-br via-transparent to-transparent ${colors.wash}`}
      />
      <div className="relative flex items-center gap-2.5 px-4 pt-4">
        <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${colors.icon}`}>
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
      <div className="relative mt-auto min-w-0 px-4 pb-4 pt-3">
        <div className="truncate text-[26px] leading-none font-semibold tracking-tight text-slate-950 tabular-nums dark:text-white">
          {value}
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <span aria-hidden className={`h-[3px] w-8 rounded-full bg-gradient-to-r ${colors.accent}`} />
          {hint ? (
            <span className="truncate text-[11px] font-medium text-slate-400 dark:text-slate-500">{hint}</span>
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
              href={`/journal?entry=${e.id}`}
              className="flex items-center justify-between gap-2 px-4 py-2.5 transition hover:bg-slate-50 dark:hover:bg-slate-800/40"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                    {e.entryNumber ?? '—'}
                  </span>
                  <Badge variant={e.status === 'posted' ? 'success' : 'outline'}>
                    {e.status}
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
                  {e.lineCount} lines
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
