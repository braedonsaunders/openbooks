'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { promptDialog } from '@/lib/prompt'
import { PagedTable, type PagedColumn } from '../../../../components/paged-table'
import { useMoney } from '../../../../components/money-provider'
import { Badge, Button, Drawer, EmptyState, Input, Label, SearchSelect } from '@openbooks/ui'
import { Switch } from '@/components/switch'
import { ContextMenu, useContextMenu } from '@openbooks/ui'

interface QueueRow {
  id: string
  objectType: string
  externalId: string
  productTitle: string | null
  title: string
  sku: string | null
  barcode: string | null
  priceMajor: string | null
  currency: string
  optionValues: Record<string, string>
  status: string
  nativeCode: string | null
  nativeName: string | null
  ignoreReason: string | null
  proposal: { kind?: string; from?: string; to?: string; message?: string } | null
}

type Decision =
  | { kind: 'match'; nativeId: string }
  | { kind: 'create_item'; code?: string; name?: string; itemKind?: string }
  | { kind: 'create_family'; code?: string }
  | { kind: 'ignore'; reason: string }
  | { kind: 'unmatch'; reason: string }

function proposalText(t: (key: string, values?: Record<string, string>) => string, row: QueueRow): string | null {
  const proposal = row.proposal
  if (!proposal?.kind) return null
  if (proposal.kind === 'sku_changed') return t('products.proposalSkuChanged', { from: proposal.from ?? '', to: proposal.to ?? '' })
  if (proposal.kind === 'deleted_at_shopify') return t('products.proposalDeleted')
  return t(proposal.kind === 'match_refused' || proposal.kind === 'link_conflict' ? 'products.proposalRefused' : 'products.proposalConflict', {
    message: proposal.message ?? '',
  })
}

/**
 * The match queue: every unmatched variant with its next action in one
 * place. Match, create and ignore happen from the row; bulk and "apply
 * to similar" cover the repetitive rest. Matched rows stay visible for
 * corrections (unmatch) but never for re-deciding.
 */
export function ProductsTab({ channelId, currency, canManage }: { channelId: string; currency: string; canManage: boolean }) {
  const t = useTranslations('channels')
  const tc = useTranslations('common')
  const { money } = useMoney(currency)
  const [rows, setRows] = useState<QueueRow[]>([])
  const [counts, setCounts] = useState({ queued: 0, matched: 0, ignored: 0 })
  const [status, setStatus] = useState<'queued' | 'matched' | 'ignored'>('queued')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [drawer, setDrawer] = useState<{ row: QueueRow; action: 'match' | 'create_item' | 'create_family' } | null>(null)
  const [itemOptions, setItemOptions] = useState<{ value: string; label: string }[] | null>(null)
  const [itemId, setItemId] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [includeSimilar, setIncludeSimilar] = useState(false)
  const [similarCount, setSimilarCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const menu = useContextMenu()
  const [menuRow, setMenuRow] = useState<QueueRow | null>(null)

  // Fetch kickoff: every update sits in a promise continuation, never
  // synchronously in the effect body (react-hooks/set-state-in-effect).
  const load = useCallback(() => {
    const params = new URLSearchParams({ status, limit: '100' })
    if (search.trim() !== '') params.set('search', search.trim())
    return fetch(`/api/channels/${channelId}/catalog?${params}`)
      .then(async (res) => {
        if (!res.ok) {
          toast.error(await readApiErrorMessage(res, t('toast.loadFailed')))
          return
        }
        const body = (await res.json()) as { rows: QueueRow[]; total: number; counts: { queued: number; matched: number; ignored: number } }
        setRows(body.rows)
        setCounts(body.counts)
        setSelected((prev) => prev.filter((id) => body.rows.some((row) => row.id === id)))
      })
      .catch(() => {
        toast.error(t('toast.loadFailed'))
      })
  }, [channelId, status, search, t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!drawer || drawer.action !== 'match') return
    let cancelled = false
    fetch('/api/forms/options?source=reference&table=items')
      .then(async (res) => {
        if (!res.ok || cancelled) return
        const body = (await res.json()) as { options: { value: string; label: string }[] }
        if (!cancelled) setItemOptions(body.options)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [drawer])

  useEffect(() => {
    if (!drawer) return
    let cancelled = false
    fetch(`/api/channels/${channelId}/catalog/similar?entryId=${drawer.row.id}`)
      .then(async (res) => {
        if (!res.ok || cancelled) return
        const body = (await res.json()) as { entryIds: string[] }
        if (!cancelled) setSimilarCount(body.entryIds.length)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [drawer, channelId])

  async function decide(entryIds: string[], decision: Decision) {
    setBusy(true)
    try {
      const res = await fetch(`/api/channels/${channelId}/catalog/decide`, {
        method: entryIds.length === 1 ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entryIds.length === 1 ? { entryId: entryIds[0], decision } : { entryIds, decision }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('toast.loadFailed')))
        return false
      }
      const body = (await res.json()) as { failed?: { entryId: string; message: string }[] }
      for (const failure of body.failed ?? []) toast.error(failure.message)
      setDrawer(null)
      setSelected([])
      await load()
      return (body.failed ?? []).length === 0
    } finally {
      setBusy(false)
    }
  }

  async function askReason(title: string, hint: string): Promise<string | null> {
    return promptDialog({ title, message: hint, label: t('products.reasonLabel') })
  }

  async function runRowAction(row: QueueRow, action: 'match' | 'create_item' | 'create_family' | 'ignore' | 'unmatch') {
    if (action === 'ignore') {
      const reason = await askReason(t('actions.ignore'), t('products.ignoreHint'))
      if (reason === null) return
      await decide([row.id], { kind: 'ignore', reason })
      return
    }
    if (action === 'unmatch') {
      const reason = await askReason(t('actions.unmatch'), t('products.unmatchHint'))
      if (reason === null) return
      await decide([row.id], { kind: 'unmatch', reason })
      return
    }
    // The decision form starts from the row, not from whatever a previous
    // decision left behind: initialize here at open time instead of syncing
    // in an effect.
    setItemId('')
    setCode(row.sku ?? '')
    setName(row.objectType === 'variant' && row.title !== 'Default' ? row.title : (row.productTitle ?? row.title))
    setIncludeSimilar(false)
    setSimilarCount(0)
    setDrawer({ row, action })
  }

  async function submitDrawer() {
    if (!drawer) return
    let ids = [drawer.row.id]
    if (includeSimilar) {
      const res = await fetch(`/api/channels/${channelId}/catalog/similar?entryId=${drawer.row.id}`)
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('toast.loadFailed')))
        return
      }
      const body = (await res.json()) as { entryIds: string[] }
      ids = [drawer.row.id, ...body.entryIds]
    }
    if (drawer.action === 'match') {
      if (itemId === '') return
      await decide(ids, { kind: 'match', nativeId: itemId })
      return
    }
    if (drawer.action === 'create_item') {
      await decide(ids, { kind: 'create_item', code: code.trim() === '' ? undefined : code.trim(), name: name.trim() === '' ? undefined : name.trim() })
      return
    }
    await decide(ids, { kind: 'create_family', code: code.trim() === '' ? undefined : code.trim() })
  }

  const columns: PagedColumn<QueueRow>[] = [
    {
      key: 'product',
      header: t('products.columnProduct'),
      cell: (row) => (
        <span>
          <span className="block font-medium">{row.objectType === 'product' ? row.title : (row.productTitle ?? row.title)}</span>
          {row.objectType === 'variant' ? <span className="block text-xs text-slate-500">{row.title}</span> : null}
        </span>
      ),
      search: (row) => `${row.title} ${row.productTitle ?? ''} ${row.sku ?? ''} ${row.barcode ?? ''}`,
    },
    {
      key: 'sku',
      header: 'SKU',
      cell: (row) => <span className="font-mono text-xs">{row.sku ?? '—'}</span>,
    },
    {
      key: 'price',
      header: 'Price',
      align: 'right',
      cell: (row) => (row.priceMajor === null ? '—' : money(row.priceMajor, { currency: row.currency })),
    },
    {
      key: 'match',
      header: t('products.columnMatch'),
      cell: (row) =>
        row.status === 'matched' ? (
          <span className="text-sm">{row.nativeName ?? row.nativeCode ?? ''}</span>
        ) : row.status === 'ignored' ? (
          <Badge variant="secondary">{t('actions.ignore')}</Badge>
        ) : (
          <Badge variant="warning">{t('products.queueBadge')}</Badge>
        ),
    },
    {
      key: 'rowActions',
      header: '',
      cell: (row) =>
        canManage && (row.status === 'queued' || row.status === 'matched') ? (
          <button
            type="button"
            aria-label={t('products.columnMatch')}
            className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            onClick={(event) => {
              setMenuRow(row)
              menu.openBelow(event.currentTarget)
            }}
          >
            •••
          </button>
        ) : null,
    },
    {
      key: 'proposal',
      header: t('products.columnProposal'),
      cell: (row) => {
        const text = proposalText(t, row)
        return text ? <span className="text-sm text-amber-700">{text}</span> : <span className="text-slate-400">—</span>
      },
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="w-64 rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
          placeholder={t('products.searchPlaceholder')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={t('products.searchPlaceholder')}
        />
        {(['queued', 'matched', 'ignored'] as const).map((key) => (
          <Button key={key} size="sm" variant={status === key ? 'default' : 'outline'} onClick={() => setStatus(key)}>
            {key === 'queued' ? t('tabs.products') : key === 'matched' ? t('products.columnMatch') : t('actions.ignore')} ·{' '}
            {counts[key]}
          </Button>
        ))}
        <span className="grow" />
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              const res = await fetch(`/api/channels/${channelId}/catalog`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
              if (!res.ok) toast.error(await readApiErrorMessage(res, t('toast.loadFailed')))
              else await load()
            } finally {
              setBusy(false)
            }
          }}
        >
          {t('actions.reimport')}
        </Button>
      </div>
      {selected.length > 0 && canManage ? (
        <div className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-800">
          <span>{t('products.selected', { count: selected.length })}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const reason = await askReason(t('actions.ignore'), t('products.ignoreHint'))
              if (reason === null) return
              await decide(selected, { kind: 'ignore', reason })
            }}
          >
            {t('actions.ignore')}
          </Button>
        </div>
      ) : null}
      {rows.length === 0 && status === 'queued' ? (
        <EmptyState title={t('products.emptyTitle')} description={t('products.emptyHint')} />
      ) : (
        <PagedTable<QueueRow>
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          empty={<EmptyState title={t('products.emptyTitle')} description={t('products.emptyHint')} />}
          selection={
            canManage
              ? {
                  getId: (row: QueueRow) => row.id,
                  selectedIds: selected,
                  onToggle: (id) => setSelected((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id])),
                  onToggleAll: (ids) => setSelected(ids),
                }
              : undefined
          }
        />
      )}
      <ContextMenu
        open={menu.open}
        position={menu.position}
        onClose={menu.close}
        items={
          menuRow
            ? [
                ...(menuRow.status === 'queued'
                  ? [
                      { key: 'match', label: t('actions.match'), onSelect: () => runRowAction(menuRow, 'match') },
                      ...(menuRow.objectType === 'variant'
                        ? [{ key: 'create_item', label: t('actions.createItem'), onSelect: () => runRowAction(menuRow, 'create_item') }]
                        : []),
                      ...(menuRow.objectType === 'product'
                        ? [{ key: 'create_family', label: t('actions.createFamily'), onSelect: () => runRowAction(menuRow, 'create_family') }]
                        : []),
                      { key: 'ignore', label: t('actions.ignore'), onSelect: () => runRowAction(menuRow, 'ignore') },
                    ]
                  : []),
                ...(menuRow.status === 'matched'
                  ? [{ key: 'unmatch', label: t('actions.unmatch'), onSelect: () => runRowAction(menuRow, 'unmatch') }]
                  : []),
              ]
            : []
        }
      />
      <Drawer open={drawer !== null} onClose={() => setDrawer(null)} title={drawer ? t('products.matchTitle', { title: drawer.row.title }) : ''}>
        {drawer ? (
          <div className="space-y-4 p-1">
            {drawer.action === 'match' ? (
              <div className="space-y-2">
                <p className="text-sm text-slate-500">{t('products.matchHint')}</p>
                {itemOptions ? (
                  <SearchSelect value={itemId} onChange={setItemId} options={itemOptions} ariaLabel={t('products.itemLabel')} />
                ) : (
                  <p className="text-sm text-slate-500">{t('products.itemLabel')}</p>
                )}
              </div>
            ) : null}
            {drawer.action !== 'match' ? (
              <div className="space-y-4">
                {drawer.action === 'create_family' ? <p className="text-sm text-slate-500">{t('products.createFamilyHint')}</p> : null}
                <div className="space-y-2">
                  <Label htmlFor="catalog-code">{t('products.codeLabel')}</Label>
                  <Input id="catalog-code" value={code} onChange={(event) => setCode(event.target.value)} />
                </div>
                {drawer.action === 'create_item' ? (
                  <div className="space-y-2">
                    <Label htmlFor="catalog-name">{t('products.nameLabel')}</Label>
                    <Input id="catalog-name" value={name} onChange={(event) => setName(event.target.value)} />
                  </div>
                ) : null}
              </div>
            ) : null}
            {similarCount > 0 ? (
              <label className="flex items-center gap-2 text-sm">
                <Switch on={includeSimilar} onToggle={() => setIncludeSimilar((value) => !value)} disabled={busy} label={t('actions.applySimilar', { count: similarCount })} />
                {t('actions.applySimilar', { count: similarCount })}
              </label>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDrawer(null)}>
                {tc('cancel')}
              </Button>
              <Button disabled={busy || (drawer.action === 'match' && itemId === '')} onClick={submitDrawer}>
                {drawer.action === 'match' ? t('actions.match') : drawer.action === 'create_item' ? t('actions.createItem') : t('actions.createFamily')}
              </Button>
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}
