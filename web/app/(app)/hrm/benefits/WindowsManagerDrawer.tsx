'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge, Button, UrlDrawer } from '@openbooks/ui'
import { PagedTable } from '../../../../components/paged-table'
import type { BenefitsWindowRow } from '../../../../lib/hrm/benefits'

/** Enrollment windows are managed from the enrollment workspace. */
export function WindowsManagerDrawer({ rows, closeHref, newHref, canManage }: {
  rows: BenefitsWindowRow[]
  closeHref: string
  newHref: string
  canManage: boolean
}) {
  const t = useTranslations('hrm')
  return (
    <UrlDrawer open closeHref={closeHref} title={t('benefits.windowsTitle')} size="xl">
      <div className="flex min-h-0 flex-col gap-4 p-4">
        {canManage ? <div className="flex items-center justify-end">
          <Button asChild><Link href={newHref as never}>{t('benefits.newWindow')}</Link></Button>
        </div> : null}
        <PagedTable
          searchable
          source="hrm_benefits_windows"
          rows={rows}
          rowKey={(row) => row.id}
          searchText={(row) => `${row.name} ${row.kindLabel} ${row.statusLabel}`}
          columns={[
            { key: 'window', header: t('benefits.columns.window'), cell: (row) => <Link href={row.windowHref as never} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{row.name}</Link> },
            { key: 'kind', header: t('benefits.columns.kind'), cell: (row) => row.kindLabel },
            { key: 'range', header: t('benefits.columns.range'), cell: (row) => row.rangeLabel },
            { key: 'elections', header: t('benefits.columns.elections'), align: 'right', cell: (row) => String(row.elections) },
            { key: 'pending', header: t('benefits.columns.pending'), align: 'right', cell: (row) => String(row.pendingApprovals) },
            { key: 'status', header: t('benefits.columns.status'), cell: (row) => <Badge variant={row.statusVariant}>{row.statusLabel}</Badge> },
            { key: 'open', header: '', cell: (row) => <Link href={row.windowHref as never}>{row.openLabel}</Link> },
          ]}
          empty={<div><p>{t('benefits.windowsEmptyTitle')}</p><p className="mt-1 text-sm text-slate-500">{t('benefits.windowsEmpty')}</p></div>}
        />
      </div>
    </UrlDrawer>
  )
}
