'use client'

import { useTranslations } from 'next-intl'
import { PagedTable, type PagedColumn } from '../../../components/paged-table'
import { Badge, EmptyState } from '@openbooks/ui'

export interface ChannelStockRow {
  channelId: string
  channelName: string
  externalLocationId: string
  externalName: string
  stockLocationCode: string
  available: string
  bufferQuantity: string
  stopSellingAtZero: boolean
  sellable: number
  availabilityError: string | null
  lastPushedQuantity: number | null
  lastShopifyQuantity: number | null
  lastPushedAt: string | null
  lastStatus: string
  conflict: { openbooksQuantity: number; shopifyQuantity: number } | null
}

/**
 * One item's storefront stock: what OpenBooks can sell beside what the
 * storefront shows, per channel and location. Read-only — the everyday
 * read of push state from the item; policy changes happen on the channel.
 */
export function ChannelStockTab({ rows }: { rows: ChannelStockRow[] }) {
  const t = useTranslations('channels')

  const columns: PagedColumn<ChannelStockRow>[] = [
    {
      key: 'channel',
      header: t('itemTab.columnChannel'),
      cell: (row) => (
        <span>
          <a className="font-medium underline" href={`/channels/${row.channelId}?tab=adapter:locations`}>
            {row.channelName}
          </a>
          <span className="block text-xs text-slate-500">
            {row.stockLocationCode} · {row.externalName}
          </span>
        </span>
      ),
      search: (row) => `${row.channelName} ${row.externalName} ${row.stockLocationCode}`,
    },
    {
      key: 'sellable',
      header: t('itemTab.columnSellable'),
      cell: (row) =>
        row.availabilityError ? (
          <span className="text-sm text-slate-500">{t('itemTab.unmeasurable')}</span>
        ) : (
          <span>
            <span className="font-medium">{row.sellable}</span>
            <span className="block text-xs text-slate-500">
              {t('itemTab.availableHint', { available: row.available, buffer: row.bufferQuantity })}
            </span>
          </span>
        ),
    },
    {
      key: 'pushed',
      header: t('itemTab.columnPushed'),
      cell: (row) => (
        <span className="text-sm">
          {row.lastPushedQuantity === null ? (
            <span className="text-slate-500">{t('locations.neverPushed')}</span>
          ) : (
            <span>
              {row.lastPushedQuantity}
              <span className="block text-xs text-slate-500">
                {row.lastPushedAt ?? ''}
              </span>
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'state',
      header: '',
      cell: (row) => {
        if (row.conflict) {
          return (
            <span>
              <Badge variant="warning">{t('locations.conflictBadge', { count: 1 })}</Badge>
              <span className="block text-xs text-slate-500">
                {t('locations.conflictLevels', { open: row.conflict.openbooksQuantity, shop: row.conflict.shopifyQuantity })}
              </span>
            </span>
          )
        }
        if (row.availabilityError) {
          return (
            <span>
              <Badge variant="warning">{t('itemTab.attention')}</Badge>
              <span className="block text-xs text-slate-500">{row.availabilityError}</span>
            </span>
          )
        }
        if (row.lastStatus === 'error') return <Badge variant="destructive">{t('locations.errorBadge', { count: 1 })}</Badge>
        if (row.lastStatus === 'ok') return <Badge variant="success">{t('locations.syncedBadge')}</Badge>
        return <Badge variant="secondary">{t('locations.pendingBadge')}</Badge>
      },
    },
  ]

  if (rows.length === 0) {
    return <EmptyState title={t('itemTab.emptyTitle')} description={t('itemTab.emptyHint')} />
  }
  return (
    <PagedTable<ChannelStockRow>
      columns={columns}
      rows={rows}
      rowKey={(row) => `${row.channelId}:${row.externalLocationId}`}
      empty={<EmptyState title={t('itemTab.emptyTitle')} description={t('itemTab.emptyHint')} />}
    />
  )
}
