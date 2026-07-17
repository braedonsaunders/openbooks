'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
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
import { money } from '@/lib/format'
import { currencySymbol } from '@/lib/statement-format'
import type { DashboardMetrics } from './_metrics'

export function WidgetCard({
  widgetId,
  data,
}: {
  widgetId: string
  data: DashboardMetrics
}) {
  const t = useTranslations('dashboard')
  const symbol = currencySymbol(data.baseCurrency)

  switch (widgetId) {
    case 'kpi-journal-lines':
      return <MetricTile icon={<BookOpen size={15} />} label={t('widgets.journalLines')} value={String(data.journalLineCount)} href="/journal" tone="teal" />
    case 'kpi-accounts-active':
      return <MetricTile icon={<Layers size={15} />} label={t('widgets.activeAccounts')} value={String(data.accountCount)} href="/accounts" tone="sky" />
    case 'kpi-entries-today':
      return <MetricTile icon={<FileText size={15} />} label={t('widgets.entriesToday')} value={String(data.entriesToday)} href="/journal" tone="teal" hint={t('metricContext.today')} />
    case 'kpi-pending-approvals':
      return <MetricTile icon={<ClipboardList size={15} />} label={t('widgets.pendingApprovals')} value={String(data.pendingApprovals)} href="/approvals" tone="amber" hint={t('metricContext.awaitingDecision')} />
    case 'kpi-ledger-balance':
      return <MetricTile icon={<Scale size={15} />} label={t('widgets.ledgerBalance')} value={money(data.ledgerSum, symbol)} href="/journal" tone="slate" />
    case 'kpi-cash-balance':
      return <MetricTile icon={<Landmark size={15} />} label={t('widgets.cashBalance')} value={money(data.cashBalance, symbol)} href="/banking" tone="emerald" hint={t('metricContext.baseCurrency', { currency: data.baseCurrency })} />
    case 'kpi-open-receivables':
      return <MetricTile icon={<CircleDollarSign size={15} />} label={t('widgets.openReceivables')} value={money(data.openReceivables, symbol)} href="/ar" tone="sky" hint={t('metricContext.outstanding')} />
    case 'kpi-overdue-receivables':
      return <MetricTile icon={<AlertTriangle size={15} />} label={t('widgets.overdueReceivables')} value={money(data.overdueReceivables, symbol)} href="/ar" tone="rose" hint={t('metricContext.pastDue')} />
    case 'kpi-open-payables':
      return <MetricTile icon={<Receipt size={15} />} label={t('widgets.openPayables')} value={money(data.openPayables, symbol)} href="/ap" tone="violet" hint={t('metricContext.outstanding')} />
    case 'kpi-overdue-payables':
      return <MetricTile icon={<AlertTriangle size={15} />} label={t('widgets.overduePayables')} value={money(data.overduePayables, symbol)} href="/ap" tone="orange" hint={t('metricContext.pastDue')} />
    case 'list-recent-entries':
      return <RecentEntriesList entries={data.recentEntries} />
    case 'list-pending-approvals':
      return <PendingApprovalsList approvals={data.pendingApprovalList} />
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
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  )
}

type MetricTone = 'teal' | 'sky' | 'emerald' | 'amber' | 'orange' | 'rose' | 'violet' | 'slate'

const METRIC_TONES: Record<MetricTone, { rail: string; icon: string; glow: string }> = {
  teal: { rail: 'bg-teal-500', icon: 'bg-teal-50 text-teal-700 ring-teal-100 dark:bg-teal-950/60 dark:text-teal-300 dark:ring-teal-900', glow: 'bg-teal-400/10 dark:bg-teal-500/5' },
  sky: { rail: 'bg-sky-500', icon: 'bg-sky-50 text-sky-700 ring-sky-100 dark:bg-sky-950/60 dark:text-sky-300 dark:ring-sky-900', glow: 'bg-sky-400/10 dark:bg-sky-500/5' },
  emerald: { rail: 'bg-emerald-500', icon: 'bg-emerald-50 text-emerald-700 ring-emerald-100 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-900', glow: 'bg-emerald-400/10 dark:bg-emerald-500/5' },
  amber: { rail: 'bg-amber-500', icon: 'bg-amber-50 text-amber-700 ring-amber-100 dark:bg-amber-950/60 dark:text-amber-300 dark:ring-amber-900', glow: 'bg-amber-400/10 dark:bg-amber-500/5' },
  orange: { rail: 'bg-orange-500', icon: 'bg-orange-50 text-orange-700 ring-orange-100 dark:bg-orange-950/60 dark:text-orange-300 dark:ring-orange-900', glow: 'bg-orange-400/10 dark:bg-orange-500/5' },
  rose: { rail: 'bg-rose-500', icon: 'bg-rose-50 text-rose-700 ring-rose-100 dark:bg-rose-950/60 dark:text-rose-300 dark:ring-rose-900', glow: 'bg-rose-400/10 dark:bg-rose-500/5' },
  violet: { rail: 'bg-violet-500', icon: 'bg-violet-50 text-violet-700 ring-violet-100 dark:bg-violet-950/60 dark:text-violet-300 dark:ring-violet-900', glow: 'bg-violet-400/10 dark:bg-violet-500/5' },
  slate: { rail: 'bg-slate-400', icon: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700', glow: 'bg-slate-400/10 dark:bg-slate-400/5' },
}

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
    <div className="relative flex h-full flex-col justify-between overflow-hidden p-4 pl-5">
      <span className={`absolute inset-y-0 left-0 w-1 ${colors.rail}`} />
      <span className={`pointer-events-none absolute -top-12 -right-10 h-28 w-28 rounded-full blur-2xl ${colors.glow}`} />
      <div className="relative flex items-start justify-between gap-3">
        <span className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{label}</span>
        <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${colors.icon}`}>
          {icon}
        </span>
      </div>
      <div className="relative min-w-0">
        <div className="truncate text-2xl font-bold tracking-tight text-slate-950 tabular-nums dark:text-white">
          {value}
        </div>
        {hint ? <div className="mt-0.5 truncate text-[11px] font-medium text-slate-400 dark:text-slate-500">{hint}</div> : null}
      </div>
    </div>
  )
  if (href) {
    return (
      <Link href={href} className="block h-full rounded-xl border border-slate-200 bg-white shadow-sm transition hover:border-teal-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-900 dark:hover:border-teal-800/60">
        {inner}
      </Link>
    )
  }
  return (
    <div className="h-full rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      {inner}
    </div>
  )
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
}: {
  approvals: DashboardMetrics['pendingApprovalList']
  title?: string
}) {
  const t = useTranslations('dashboard')
  if (approvals.length === 0) {
    return (
      <CardShell title={title ?? t('widgets.pendingApprovalsList')} icon={<ClipboardList size={14} />}>
        <EmptyRow />
      </CardShell>
    )
  }
  return (
    <CardShell title={title ?? t('widgets.pendingApprovalsList')} icon={<ClipboardList size={14} />} href="/approvals">
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {approvals.map((a) => (
          <li key={a.id}>
            <Link
              href="/approvals"
              className="flex items-center justify-between gap-2 px-4 py-2.5 transition hover:bg-slate-50 dark:hover:bg-slate-800/40"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                    {a.targetKind}
                  </span>
                  <Badge variant="warning">Step {a.currentStep}</Badge>
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
  const t = useTranslations('dashboard')
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
                  <Badge variant="outline">{d.kind}</Badge>
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
