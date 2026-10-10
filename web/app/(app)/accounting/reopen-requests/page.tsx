import { randomUUID } from 'node:crypto'
import { getTranslations } from 'next-intl/server'
import { Badge, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '@/components/page-layout'
import { RegisteredListTable } from '@/components/registered-list-table'
import { requirePermission } from '@/lib/authz'
import { applicationContextFromSession } from '@/lib/application/context'
import { listPeriodReopenRequests } from '@/lib/application/close'
import { ReopenDecision } from './ReopenDecision'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('accounting.reopenRequests')
  return { title: t('title') }
}

type ReopenRequestRow = Awaited<ReturnType<typeof listPeriodReopenRequests>>['requests'][number]

/**
 * Period reopen requests, decided outside Setup. A reopen is requested from
 * the period in Setup and must be approved by someone else holding
 * close.reopen; this page is that approver's surface (the Inbox lists the
 * same pending requests). Reopening invalidates the organization-wide close
 * review, so like the close command it needs an unrestricted subsidiary
 * scope; a scoped approver is told so instead of meeting an empty list.
 */
export default async function ReopenRequestsPage() {
  const t = await getTranslations('accounting.reopenRequests')
  const authz = await requirePermission('close.reopen')
  const header = <PageHeader title={t('title')} description={t('description')} />
  if (authz.allowedSubsidiaryIds !== null) {
    return (
      <ListPageLayout header={header}>
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100" role="status">
          {t('scopedApprover')}
        </p>
      </ListPageLayout>
    )
  }
  const context = applicationContextFromSession(authz, 'api', randomUUID())
  const { requests } = await listPeriodReopenRequests(context, { limit: 100 })
  const statusVariant = (status: unknown) => status === 'requested' ? 'warning' : status === 'approved' ? 'success' : status === 'rejected' ? 'destructive' : 'secondary'
  const text = (value: unknown) => (value == null ? '—' : String(value))
  return (
    <ListPageLayout header={header}>
      <RegisteredListTable<ReopenRequestRow>
        source="close_reopen_requests"
        rows={requests}
        rowKey={(row) => String(row.id)}
        empty={t('empty')}
        columns={[
          { key: 'period', header: <>{t('columns.period')}</>, cell: (row) => <>{text(row.period)}</>, search: (row) => text(row.period) },
          { key: 'scope', header: <>{t('columns.scope')}</>, cell: (row) => <>{[row.book, row.subsidiary].filter(Boolean).map(String).join(' · ')}</> },
          { key: 'modules', header: <>{t('columns.modules')}</>, cell: (row) => <>{Array.isArray(row.modules) ? row.modules.join(', ') : '—'}</> },
          { key: 'reason', header: <>{t('columns.reason')}</>, cell: (row) => <>{text(row.reason)}</>, search: (row) => text(row.reason) },
          { key: 'requestedBy', header: <>{t('columns.requestedBy')}</>, cell: (row) => <>{text(row.requestedBy)}</>, search: (row) => text(row.requestedBy) },
          { key: 'status', header: <>{t('columns.status')}</>, cell: (row) => <Badge variant={statusVariant(row.status)}>{t(`status.${String(row.status)}` as never)}</Badge> },
          {
            key: 'decision',
            header: <></>,
            className: 'px-3 py-2 text-right',
            cell: (row) => row.status === 'requested'
              ? <ReopenDecision requestId={String(row.id)} ownRequest={row.requestedById === authz.user.id} />
              : <span className="text-xs text-slate-500 dark:text-slate-400">{text(row.approvedBy)}</span>,
          },
        ]}
      />
    </ListPageLayout>
  )
}
