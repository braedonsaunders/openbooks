'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  BookOpen,
  CheckCircle2,
  ClipboardList,
  FileText,
  Layers,
  NotebookPen,
  Receipt,
  Scale,
} from 'lucide-react'
import { Badge } from '@openbooks/ui'
import { money } from '@/lib/format'
import type { DashboardMetrics } from './_metrics'
import type { DashboardQuickAction } from '@openbooks/schema'

export function WidgetCard({
  widgetId,
  data,
  quickActions,
}: {
  widgetId: string
  data: DashboardMetrics
  quickActions?: DashboardQuickAction[] | null
}) {
  const t = useTranslations('dashboard')

  switch (widgetId) {
    case 'kpi-journal-entries':
      return <CountTile icon={<NotebookPen size={14} />} label={t('widgets.journalEntries')} value={String(data.journalEntryCount)} href="/journal" />
    case 'kpi-journal-lines':
      return <CountTile icon={<BookOpen size={14} />} label={t('widgets.journalLines')} value={String(data.journalLineCount)} href="/journal" />
    case 'kpi-accounts-active':
      return <CountTile icon={<Layers size={14} />} label={t('widgets.activeAccounts')} value={String(data.accountCount)} href="/accounts" />
    case 'kpi-entries-today':
      return <CountTile icon={<FileText size={14} />} label={t('widgets.entriesToday')} value={String(data.entriesToday)} href="/journal" />
    case 'kpi-pending-approvals':
      return <CountTile icon={<ClipboardList size={14} />} label={t('widgets.pendingApprovals')} value={String(data.pendingApprovals)} href="/approvals" />
    case 'kpi-ledger-balance':
      return <CountTile icon={<Scale size={14} />} label={t('widgets.ledgerBalance')} value={money(data.ledgerSum)} href="/journal" />
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

function CountTile({
  icon,
  label,
  value,
  href,
}: {
  icon: React.ReactNode
  label: string
  value: string
  href?: string
}) {
  const inner = (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-4">
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-teal-50 text-teal-700 ring-1 ring-teal-100 ring-inset dark:bg-teal-950/50 dark:text-teal-300">
        {icon}
      </span>
      <span className="text-2xl font-bold tracking-tight text-slate-900 tabular-nums dark:text-white">
        {value}
      </span>
      <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</span>
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
