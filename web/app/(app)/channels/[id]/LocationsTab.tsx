'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { promptDialog } from '@/lib/prompt'
import { PagedTable, type PagedColumn } from '../../../../components/paged-table'
import { Badge, Button, Drawer, EmptyState, Label, SearchSelect, Switch } from '@openbooks/ui'

interface LocationRow {
  id: string
  channelId: string
  externalLocationId: string
  externalName: string
  stockLocationId: string | null
  syncInventory: boolean
  fulfilsOrders: boolean
}

/**
 * The Locations tab: every Shopify location with its stock mapping and
 * sync flags. Unmapped rows say what happens to their orders (parked,
 * never moved) so the operator maps with the consequence in view.
 */
export function LocationsTab({ channelId, canManage }: { channelId: string; canManage: boolean }) {
  const t = useTranslations('channels')
  const tc = useTranslations('common')
  const [rows, setRows] = useState<LocationRow[]>([])
  const [mapping, setMapping] = useState<LocationRow | null>(null)
  const [options, setOptions] = useState<{ value: string; label: string }[] | null>(null)
  const [stockId, setStockId] = useState('')
  const [sync, setSync] = useState(true)
  const [fulfils, setFulfils] = useState(true)
  const [busy, setBusy] = useState(false)

  // Fetch kickoff: every update sits in a promise continuation, never
  // synchronously in the effect body (react-hooks/set-state-in-effect).
  const load = useCallback(() => {
    return fetch(`/api/channels/${channelId}/locations`)
      .then(async (res) => {
        if (!res.ok) {
          toast.error(await readApiErrorMessage(res))
          return
        }
        const body = (await res.json()) as { locations: LocationRow[] }
        setRows(body.locations)
      })
      .catch(() => {
        toast.error(t('toast.loadFailed'))
      })
  }, [channelId, t])

  const loadOptions = useCallback(() => {
    return fetch(`/api/channels/${channelId}/stock-locations`)
      .then(async (res) => {
        if (!res.ok) {
          toast.error(await readApiErrorMessage(res))
          return
        }
        const body = (await res.json()) as { options: { value: string; label: string }[] }
        setOptions(body.options)
      })
      .catch(() => {
        toast.error(t('toast.loadFailed'))
      })
  }, [channelId, t])

  useEffect(() => {
    void load()
    void loadOptions()
  }, [load, loadOptions])

  // The edit form starts from the picked row, not from whatever a previous
  // row left behind: initialize here at pick time instead of syncing in an
  // effect.
  function pick(row: LocationRow) {
    setMapping(row)
    setStockId(row.stockLocationId ?? '')
    setSync(row.syncInventory)
    setFulfils(row.fulfilsOrders)
  }

  function stockLabel(row: LocationRow): string | null {
    if (!row.stockLocationId) return null
    return options?.find((option) => option.value === row.stockLocationId)?.label ?? row.stockLocationId
  }

  async function saveMapping() {
    if (!mapping) return
    setBusy(true)
    try {
      const res = await fetch(`/api/channels/${channelId}/locations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert',
          externalLocationId: mapping.externalLocationId,
          externalName: mapping.externalName,
          stockLocationId: stockId === '' ? null : stockId,
          syncInventory: sync,
          fulfilsOrders: fulfils,
        }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res))
        return
      }
      setMapping(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function unmap(row: LocationRow) {
    const reason = await promptDialog({ title: t('actions.unmatch'), message: t('locations.unmappedHint'), label: t('products.reasonLabel') })
    if (reason === null) return
    setBusy(true)
    try {
      const res = await fetch(`/api/channels/${channelId}/locations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'unlink', externalLocationId: row.externalLocationId, reason }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res))
        return
      }
      await load()
    } finally {
      setBusy(false)
    }
  }

  const columns: PagedColumn<LocationRow>[] = [
    {
      key: 'shopify',
      header: t('locations.columnShopify'),
      cell: (row) => <span className="font-medium">{row.externalName}</span>,
      search: (row) => `${row.externalName} ${stockLabel(row) ?? ''}`,
    },
    {
      key: 'stock',
      header: t('locations.columnStock'),
      cell: (row) => {
        const label = stockLabel(row)
        return label ? (
          <span className="text-sm">{label}</span>
        ) : (
          <span>
            <Badge variant="warning">{t('locations.unmapped')}</Badge>
            <span className="block text-xs text-slate-500">{t('locations.unmappedHint')}</span>
          </span>
        )
      },
    },
    {
      key: 'flags',
      header: '',
      cell: (row) => (
        <span className="text-xs text-slate-500">
          {row.syncInventory ? t('locations.syncStock') : ''}{row.syncInventory && row.fulfilsOrders ? ' · ' : ''}{row.fulfilsOrders ? t('locations.fulfils') : ''}
        </span>
      ),
    },
    ...(canManage
      ? [
          {
            key: 'rowActions',
            header: '',
            cell: (row: LocationRow) => (
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => pick(row)}>
                  {t('actions.map')}
                </Button>
                {row.stockLocationId ? (
                  <Button size="sm" variant="ghost" onClick={() => unmap(row)}>
                    {t('actions.unmatch')}
                  </Button>
                ) : null}
              </span>
            ),
          } as PagedColumn<LocationRow>,
        ]
      : []),
  ]

  return (
    <div className="space-y-3">
      {canManage ? (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const res = await fetch(`/api/channels/${channelId}/locations/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
                if (!res.ok) toast.error(await readApiErrorMessage(res))
                else await load()
              } finally {
                setBusy(false)
              }
            }}
          >
            {t('actions.reimport')}
          </Button>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title={t('locations.emptyTitle')} description={t('locations.emptyHint')} />
      ) : (
        <PagedTable columns={columns} rows={rows} total={rows.length} empty={t('locations.emptyTitle')} />
      )}
      <Drawer open={mapping !== null} onClose={() => setMapping(null)} title={mapping ? t('locations.mapTitle', { name: mapping.externalName }) : ''}>
        {mapping ? (
          <div className="space-y-4 p-1">
            <div className="space-y-2">
              <Label>{t('locations.stockLabel')}</Label>
              {options ? (
                <SearchSelect value={stockId} onChange={setStockId} options={options} clearable ariaLabel={t('locations.stockLabel')} />
              ) : (
                <p className="text-sm text-slate-500">{stockLabel(mapping) ?? t('locations.unmapped')}</p>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={sync} onCheckedChange={setSync} />
              {t('locations.syncStock')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={fulfils} onCheckedChange={setFulfils} />
              {t('locations.fulfils')}
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setMapping(null)}>
                {tc('cancel')}
              </Button>
              <Button disabled={busy} onClick={saveMapping}>
                {tc('save')}
              </Button>
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}
