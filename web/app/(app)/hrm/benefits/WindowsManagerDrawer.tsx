'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge, Button, UrlDrawer } from '@openbooks/ui'
import { PreparedPagedTable } from '../../../../components/prepared-paged-table'
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
        <PreparedPagedTable
          source="hrm_benefits_windows"
          rows={rows.map((row) => ({
            id: row.id,
            searchText: `${row.name} ${row.kindLabel} ${row.statusLabel}`,
            cells: [
              <Link key="name" href={row.windowHref as never} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{row.name}</Link>,
              row.kindLabel, row.rangeLabel, String(row.elections), String(row.pendingApprovals),
              <Badge key="status" variant={row.statusVariant}>{row.statusLabel}</Badge>,
              <Link key="open" href={row.windowHref as never}>{row.openLabel}</Link>,
            ],
          }))}
          columns={[
            { key: 'window', header: t('benefits.columns.window') },
            { key: 'kind', header: t('benefits.columns.kind') },
            { key: 'range', header: t('benefits.columns.range') },
            { key: 'elections', header: t('benefits.columns.elections'), align: 'right' },
            { key: 'pending', header: t('benefits.columns.pending'), align: 'right' },
            { key: 'status', header: t('benefits.columns.status') },
            { key: 'open', header: '' },
          ]}
          empty={<div><p>{t('benefits.windowsEmptyTitle')}</p><p className="mt-1 text-sm text-slate-500">{t('benefits.windowsEmpty')}</p></div>}
        />
      </div>
    </UrlDrawer>
  )
}
