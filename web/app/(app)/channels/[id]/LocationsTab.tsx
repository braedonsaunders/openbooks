'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { confirmDialog } from '@/lib/confirm'
import { promptDialog } from '@/lib/prompt'
import { mergeHref } from '../../../../lib/list-params'
import { PagedTable, type PagedColumn } from '../../../../components/paged-table'
import { DrawerTabStrip } from '../../../../components/drawer-tab-strip'
import { Badge, Button, Drawer, EmptyState, Input, Label, SearchSelect } from '@openbooks/ui'
import { Switch } from '@/components/switch'
import { conflictsForLocation, dedupeConflicts, resolveLocationSection } from './location-sections'

interface LocationRow {
  id: string
  channelId: string
  externalLocationId: string
  externalName: string
  stockLocationId: string | null
  syncInventory: boolean
  fulfilsOrders: boolean
  bufferQuantity: string
  stopSellingAtZero: boolean
}

interface SyncState {
  stockLocationId: string
  stockLocationCode: string
  externalLocationId: string
  externalName: string
  syncInventory: boolean
  bufferQuantity: string
  stopSellingAtZero: boolean
  mappedPairs: number
  lastPushedAt: string | null
  openConflicts: number
  errorPairs: number
  pendingPairs: number
}

interface ConflictRow {
  id: string
  channelId: string
  channelName: string
  stockLocationId: string
  stockLocationCode: string
  externalName: string
  itemId: string
  itemCode: string | null
  itemName: string
  openbooksQuantity: number
  shopifyQuantity: number
  createdAt: string
}

interface PolicyRow {
  itemId: string
  itemCode: string | null
  itemName: string
  bufferQuantity: string | null
  stopSellingAtZero: boolean | null
  syncInventory: boolean
}

/**
 * Locations & stock: the mapped locations are the parent body. A location
 * with open stock conflicts opens them from its row in a drawer; per-item
 * overrides live under their own subtab. Everyday reads state and the next
 * action; drawers configure.
 */
export function LocationsTab({ channelId, canManage }: { channelId: string; canManage: boolean }) {
  const t = useTranslations('channels')
  const tc = useTranslations('common')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const sp = Object.fromEntries(searchParams.entries())
  const section = resolveLocationSection(sp)
  const sectionTabs = [
    { key: 'mapped', label: t('locations.tabs.mapped'), href: mergeHref(pathname, sp, { section: 'mapped' }) },
    { key: 'policies', label: t('locations.overrideTitle'), href: mergeHref(pathname, sp, { section: 'policies' }) },
  ]
  const [conflictLocation, setConflictLocation] = useState<LocationRow | null>(null)
  const [rows, setRows] = useState<LocationRow[]>([])
  const [states, setStates] = useState<SyncState[]>([])
  const [conflicts, setConflicts] = useState<ConflictRow[]>([])
  const [policies, setPolicies] = useState<PolicyRow[]>([])
  // Reachability keys on the loaded conflict identity, never the narrower
  // push-state count: an unlinked variant keeps its conflict listed with no
  // state row, and a doubly-mapped stock location returns one row per mapping.
  const openConflicts = dedupeConflicts(conflicts)
  const [mapping, setMapping] = useState<LocationRow | null>(null)
  const [options, setOptions] = useState<{ value: string; label: string }[] | null>(null)
  const [itemOptions, setItemOptions] = useState<{ value: string; label: string }[]>([])
  const [stockId, setStockId] = useState('')
  const [sync, setSync] = useState(true)
  const [fulfils, setFulfils] = useState(true)
  const [buffer, setBuffer] = useState('')
  const [stop, setStop] = useState(true)
  const [overrideItem, setOverrideItem] = useState('')
  const [overrideBuffer, setOverrideBuffer] = useState('')
  const [overrideInheritBuffer, setOverrideInheritBuffer] = useState(true)
  const [overrideStop, setOverrideStop] = useState(true)
  const [overrideInheritStop, setOverrideInheritStop] = useState(true)
  const [overrideSync, setOverrideSync] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    return fetch(`/api/channels/${channelId}/locations`)
      .then(async (res) => {
        if (!res.ok) {
          toast.error(await readApiErrorMessage(res, t('toast.loadFailed')))
          return
        }
        const body = (await res.json()) as { locations: LocationRow[] }
        setRows(body.locations)
      })
      .catch(() => {
        toast.error(t('toast.loadFailed'))
      })
  }, [channelId, t])

  const loadSync = useCallback(() => {
    return fetch(`/api/channels/${channelId}/inventory`)
      .then(async (res) => {
        if (!res.ok) {
          toast.error(await readApiErrorMessage(res, t('toast.loadFailed')))
          return
        }
        const body = (await res.json()) as { states: SyncState[]; conflicts: ConflictRow[]; policies: PolicyRow[] }
        setStates(body.states)
        setConflicts(body.conflicts)
        setPolicies(body.policies)
      })
      .catch(() => {
        toast.error(t('toast.loadFailed'))
      })
  }, [channelId, t])

  const loadOptions = useCallback(() => {
    return fetch(`/api/channels/${channelId}/stock-locations`)
      .then(async (res) => {
        if (!res.ok) {
          toast.error(await readApiErrorMessage(res, t('toast.loadFailed')))
          return
        }
        const body = (await res.json()) as { options: { value: string; label: string }[] }
        setOptions(body.options)
      })
      .catch(() => {
        toast.error(t('toast.loadFailed'))
      })
  }, [channelId, t])

  const loadItems = useCallback(() => {
    return fetch('/api/forms/options?source=reference&table=items')
      .then(async (res) => {
        if (!res.ok) return
        const body = (await res.json()) as { options: { value: string; label: string }[] }
        setItemOptions(body.options)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    void load()
    void loadSync()
    void loadOptions()
    void loadItems()
  }, [load, loadSync, loadOptions, loadItems])

  function pick(row: LocationRow) {
    setConflictLocation(null)
    setMapping(row)
    setStockId(row.stockLocationId ?? '')
    setSync(row.syncInventory)
    setFulfils(row.fulfilsOrders)
    setBuffer(row.bufferQuantity === '0.0000' ? '' : row.bufferQuantity)
    setStop(row.stopSellingAtZero)
  }

  function pickPolicy(policy: PolicyRow) {
    setOverrideItem(policy.itemId)
    setOverrideBuffer(policy.bufferQuantity ?? '')
    setOverrideInheritBuffer(policy.bufferQuantity === null)
    setOverrideStop(policy.stopSellingAtZero ?? true)
    setOverrideInheritStop(policy.stopSellingAtZero === null)
    setOverrideSync(policy.syncInventory)
  }

  function reviewConflicts(row: LocationRow) {
    setMapping(null)
    setConflictLocation(row)
  }

  function stockLabel(row: LocationRow): string | null {
    if (!row.stockLocationId) return null
    return options?.find((option) => option.value === row.stockLocationId)?.label ?? row.stockLocationId
  }

  function stateFor(row: LocationRow): SyncState | null {
    return states.find((state) => state.externalLocationId === row.externalLocationId) ?? null
  }

  async function postInventory(body: Record<string, unknown>): Promise<boolean> {
    const res = await fetch(`/api/channels/${channelId}/inventory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      toast.error(await readApiErrorMessage(res, t('toast.loadFailed')))
      return false
    }
    await loadSync()
    return true
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
          bufferQuantity: buffer === '' ? null : buffer,
          stopSellingAtZero: stop,
        }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('toast.loadFailed')))
        return
      }
      setMapping(null)
      await load()
      await loadSync()
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
        toast.error(await readApiErrorMessage(res, t('toast.loadFailed')))
        return
      }
      await load()
      await loadSync()
    } finally {
      setBusy(false)
    }
  }

  async function pushNow(row: LocationRow) {
    if (!row.stockLocationId) return
    setBusy(true)
    try {
      await postInventory({ action: 'push-now', stockLocationId: row.stockLocationId })
    } finally {
      setBusy(false)
    }
  }

  async function resolveConflict(conflictId: string, resolution: 'pushed_openbooks' | 'accepted_shopify') {
    setBusy(true)
    try {
      await postInventory({ action: 'resolve', conflictId, resolution })
    } finally {
      setBusy(false)
    }
  }

  async function resolveAll(resolution: 'pushed_openbooks' | 'accepted_shopify') {
    const confirmed = await confirmDialog(t('locations.resolveAllConfirm', { count: openConflicts.length }))
    if (!confirmed) return
    setBusy(true)
    try {
      await postInventory({ action: 'resolve-all', resolution })
    } finally {
      setBusy(false)
    }
  }

  async function saveOverride() {
    if (overrideItem === '') return
    setBusy(true)
    try {
      const ok = await postInventory({
        action: 'set-policy',
        itemId: overrideItem,
        bufferQuantity: overrideInheritBuffer ? null : overrideBuffer === '' ? null : overrideBuffer,
        stopSellingAtZero: overrideInheritStop ? null : overrideStop,
        syncInventory: overrideSync,
      })
      if (ok) {
        setOverrideItem('')
        setOverrideBuffer('')
        setOverrideInheritBuffer(true)
        setOverrideInheritStop(true)
        setOverrideSync(true)
      }
    } finally {
      setBusy(false)
    }
  }

  async function clearOverride(itemId: string) {
    setBusy(true)
    try {
      await postInventory({ action: 'clear-policy', itemId })
    } finally {
      setBusy(false)
    }
  }

  function syncBadge(row: LocationRow) {
    const state = stateFor(row)
    if (!row.stockLocationId || !row.syncInventory) {
      return <Badge variant="outline">{t('locations.pausedBadge')}</Badge>
    }
    if (!state) return <Badge variant="secondary">{t('locations.pendingBadge')}</Badge>
    if (state.openConflicts > 0) return <Badge variant="warning">{t('locations.conflictBadge', { count: state.openConflicts })}</Badge>
    if (state.errorPairs > 0) return <Badge variant="destructive">{t('locations.errorBadge', { count: state.errorPairs })}</Badge>
    if (state.pendingPairs > 0 || !state.lastPushedAt) return <Badge variant="secondary">{t('locations.pendingBadge')}</Badge>
    return <Badge variant="success">{t('locations.syncedBadge')}</Badge>
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
      key: 'sync',
      header: t('locations.columnSync'),
      cell: (row) => {
        const state = stateFor(row)
        return (
          <span>
            {syncBadge(row)}
            <span className="block text-xs text-slate-500">
              {state?.lastPushedAt ? t('locations.lastPush', { time: state.lastPushedAt }) : t('locations.neverPushed')}
            </span>
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
    {
      key: 'rowActions',
      header: '',
      cell: (row: LocationRow) => (
        <span className="flex gap-1">
          {canManage ? (
            <Button size="sm" variant="ghost" onClick={() => pick(row)}>
              {t('actions.map')}
            </Button>
          ) : null}
          {conflictsForLocation(openConflicts, row.stockLocationId).length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => reviewConflicts(row)}>
              {t('locations.conflictBadge', { count: conflictsForLocation(openConflicts, row.stockLocationId).length })}
            </Button>
          ) : null}
          {canManage && row.stockLocationId && row.syncInventory ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => pushNow(row)}>
              {t('locations.pushNow')}
            </Button>
          ) : null}
          {canManage && row.stockLocationId ? (
            <Button size="sm" variant="ghost" onClick={() => unmap(row)}>
              {t('actions.unmatch')}
            </Button>
          ) : null}
        </span>
      ),
    } as PagedColumn<LocationRow>,
  ]

  const conflictColumns: PagedColumn<ConflictRow>[] = [
    {
      key: 'item',
      header: t('locations.conflictItem'),
      cell: (row) => (
        <span>
          <span className="font-medium">{row.itemCode ?? row.itemName}</span>
          <span className="block text-xs text-slate-500">{row.stockLocationCode} · {row.externalName}</span>
        </span>
      ),
      search: (row) => `${row.itemCode ?? ''} ${row.itemName} ${row.externalName}`,
    },
    {
      key: 'quantities',
      header: t('locations.conflictQuantities'),
      cell: (row) => (
        <span className="text-sm">{t('locations.conflictLevels', { open: row.openbooksQuantity, shop: row.shopifyQuantity })}</span>
      ),
    },
    ...(canManage
      ? [
          {
            key: 'rowActions',
            header: '',
            cell: (row: ConflictRow) => (
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => resolveConflict(row.id, 'pushed_openbooks')}>
                  {t('locations.pushOurs')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => resolveConflict(row.id, 'accepted_shopify')}>
                  {t('locations.acceptTheirs')}
                </Button>
              </span>
            ),
          } as PagedColumn<ConflictRow>,
        ]
      : []),
  ]

  const visibleTabs = canManage ? sectionTabs : sectionTabs.filter((tab) => tab.key === 'mapped')
  const visibleSection = section === 'policies' && !canManage ? 'mapped' : section
  const locationConflicts = conflictsForLocation(openConflicts, conflictLocation?.stockLocationId ?? null)

  function selectSection(key: string) {
    const tab = sectionTabs.find((entry) => entry.key === key)
    if (tab) router.push(tab.href)
  }

  return (
    <div className="space-y-3">
      <DrawerTabStrip
        tabs={visibleTabs}
        activeKey={visibleSection}
        onSelect={selectSection}
        ariaLabel={t('locations.tabs.ariaLabel')}
      />
      {visibleSection === 'mapped' ? (
        <>
          <h2 className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('locations.tabs.mapped')}</h2>
          {openConflicts.length > 0 ? (
            <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-medium text-amber-900 dark:text-amber-100">{t('locations.conflictsTitle', { count: openConflicts.length })}</h2>
                  <p className="text-xs text-amber-700 dark:text-amber-300">{t('locations.conflictsHint')}</p>
                </div>
                {canManage ? (
                  <span className="flex gap-1">
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => resolveAll('pushed_openbooks')}>
                      {t('locations.pushAll')}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => resolveAll('accepted_shopify')}>
                      {t('locations.acceptAll')}
                    </Button>
                  </span>
                ) : null}
              </div>
            </section>
          ) : null}
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
                if (!res.ok) toast.error(await readApiErrorMessage(res, t('toast.loadFailed')))
                else {
                  await load()
                  await loadSync()
                }
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
        <PagedTable<LocationRow>
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          empty={<EmptyState title={t('locations.emptyTitle')} description={t('locations.unmappedHint')} />}
        />
      )}
        </>
      ) : (
        <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="space-y-3">
            <div>
              <h2 className="text-sm font-medium text-slate-900 dark:text-slate-100">
                {t('locations.overrideTitle')} · {t('locations.overrideSummary', { count: policies.length })}
              </h2>
              <p className="text-xs text-slate-500">{t('locations.overrideHint')}</p>
            </div>
            <div className="space-y-3 pt-1">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-52 flex-1 space-y-1">
                  <Label>{t('locations.overrideItem')}</Label>
                  <SearchSelect value={overrideItem} onChange={setOverrideItem} options={itemOptions} ariaLabel={t('locations.overrideItem')} />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Switch on={!overrideInheritBuffer} onToggle={() => setOverrideInheritBuffer((value) => !value)} disabled={busy} label={t('locations.overrideBuffer')} />
                  {t('locations.overrideBuffer')}
                </label>
                {!overrideInheritBuffer ? (
                  <Input
                    className="w-24"
                    inputMode="decimal"
                    aria-label={t('locations.bufferLabel')}
                    value={overrideBuffer}
                    onChange={(event) => setOverrideBuffer(event.target.value)}
                    placeholder="2"
                  />
                ) : null}
                <label className="flex items-center gap-2 text-sm">
                  <Switch on={!overrideInheritStop} onToggle={() => setOverrideInheritStop((value) => !value)} disabled={busy} label={t('locations.stopLabel')} />
                  {t('locations.stopLabel')}
                </label>
                {!overrideInheritStop ? (
                  <label className="flex items-center gap-2 text-sm">
                    <Switch on={overrideStop} onToggle={() => setOverrideStop((value) => !value)} disabled={busy} label={t('locations.stopLabel')} />
                    {overrideStop ? t('locations.stopOn') : t('locations.stopOff')}
                  </label>
                ) : null}
                <label className="flex items-center gap-2 text-sm">
                  <Switch on={overrideSync} onToggle={() => setOverrideSync((value) => !value)} disabled={busy} label={t('locations.syncStock')} />
                  {overrideSync ? t('locations.syncOn') : t('locations.syncOff')}
                </label>
                <Button size="sm" disabled={busy || overrideItem === ''} onClick={saveOverride}>
                  {tc('actions.save')}
                </Button>
              </div>
            </div>
            {policies.length > 0 ? (
              <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                {policies.map((policy) => (
                  <li key={policy.itemId} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="min-w-0 truncate">
                      {policy.itemCode ?? policy.itemName}
                      <span className="text-slate-400">
                        {' · '}
                        {policy.bufferQuantity ?? t('locations.inherited')}
                        {' · '}
                        {policy.stopSellingAtZero === null ? t('locations.inherited') : policy.stopSellingAtZero ? t('locations.stopOn') : t('locations.stopOff')}
                        {policy.syncInventory ? '' : ` · ${t('locations.syncOff')}`}
                      </span>
                    </span>
                    <span className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => pickPolicy(policy)}>
                        {t('actions.map')}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => clearOverride(policy.itemId)}>
                        {t('locations.clearOverride')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      )}
      <Drawer
        open={conflictLocation !== null}
        onClose={() => setConflictLocation(null)}
        title={conflictLocation ? t('locations.conflictsTitle', { count: locationConflicts.length }) : ''}
      >
        {conflictLocation ? (
          <div className="space-y-3 p-1">
            <p className="text-sm text-slate-500">
              {conflictLocation.externalName} · {t('locations.conflictsHint')}
            </p>
            <PagedTable<ConflictRow>
              columns={conflictColumns}
              rows={locationConflicts}
              rowKey={(row) => row.id}
              empty={<EmptyState title={t('locations.conflictsTitle', { count: 0 })} description={t('locations.conflictsHint')} />}
            />
          </div>
        ) : null}
      </Drawer>
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
              <Switch on={sync} onToggle={() => setSync((value) => !value)} disabled={busy} label={t('locations.syncStock')} />
              {t('locations.syncStock')}
            </label>
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-sm">
                <Switch on={fulfils} onToggle={() => setFulfils((value) => !value)} disabled={busy} label={t('locations.fulfils')} />
                {t('locations.fulfils')}
              </label>
              <p className="text-xs text-slate-500">{t(fulfils ? 'locations.fulfilsOnHint' : 'locations.fulfilsOffHint')}</p>
            </div>
            <div className="space-y-2">
              <Label>{t('locations.bufferLabel')}</Label>
              <Input
                inputMode="decimal"
                aria-label={t('locations.bufferLabel')}
                value={buffer}
                onChange={(event) => setBuffer(event.target.value)}
                placeholder="0"
              />
              <p className="text-xs text-slate-500">{t('locations.bufferHint')}</p>
            </div>
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-sm">
                <Switch on={stop} onToggle={() => setStop((value) => !value)} disabled={busy} label={t('locations.stopLabel')} />
                {t('locations.stopLabel')}
              </label>
              <p className="text-xs text-slate-500">{t('locations.stopHint')}</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setMapping(null)}>
                {tc('actions.cancel')}
              </Button>
              <Button disabled={busy} onClick={saveMapping}>
                {tc('actions.save')}
              </Button>
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}
