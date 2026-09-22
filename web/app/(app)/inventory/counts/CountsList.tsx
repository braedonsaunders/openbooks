'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { Badge, Button, Input, Label, SearchSelect, UrlDrawer } from '@openbooks/ui'
import { PagedTable, type PagedColumn } from '../../../../components/paged-table'
import { useBusinessToday } from '../../../../components/business-date-provider'
import type { StockCountDetail, StockCountSummary } from '@openbooks/engine/src/inventory/stock-count-queries.ts'

const field = 'space-y-1.5'
const OPEN_NEW_COUNT = 'openbooks:inventory-new-count'

/** Header action that opens the already-loaded count editor synchronously. */
export function NewCountButton({ label }: { label: string }) {
  const router = useRouter()
  return (
    <Button
      onClick={() => {
        window.dispatchEvent(new Event(OPEN_NEW_COUNT))
        router.replace('/inventory?inventoryView=counts&count=new', { scroll: false })
      }}
    >
      <Plus size={15} /> {label}
    </Button>
  )
}

async function countAction(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch('/api/inventory/counts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...body }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const detail =
      typeof (data as { error?: unknown }).error === 'string' &&
      ((data as { error: string }).error.trim() ? true : false)
        ? (data as { error: string }).error.trim()
        : 'Request failed'
    throw new Error(detail)
  }
  return await res.json() as Record<string, unknown>
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  const variant =
    status === 'posted'
      ? 'success'
      : status === 'review'
        ? 'warning'
        : status === 'cancelled'
          ? 'secondary'
          : 'default'
  return <Badge variant={variant as 'success' | 'warning' | 'secondary' | 'default'}>{label}</Badge>
}

export function CountsList({
  counts,
  locations,
  subsidiaries,
  items,
  stockLocations,
  lots,
  canPost,
  createRequested = false,
  selectedCountId,
}: {
  counts: StockCountSummary[]
  locations: { id: string; name: string | null }[]
  subsidiaries: { id: string; name: string | null }[]
  items: { id: string; code: string | null; name: string | null }[]
  stockLocations: { id: string; code: string | null }[]
  lots: { id: string; item_id: string; lot_number: string }[]
  canPost: boolean
  createRequested?: boolean
  selectedCountId?: string
}) {
  const t = useTranslations('inventory')
  const router = useRouter()
  const [createOpen, setCreateOpen] = useState(createRequested)
  const [selectedId, setSelectedId] = useState<string | null>(selectedCountId ?? null)
  const [detail, setDetail] = useState<StockCountDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  const locationOptions = locations.map((l) => ({ value: l.id, label: l.name ?? l.id }))
  const subsidiaryOptions = subsidiaries.map((s) => ({ value: s.id, label: s.name ?? s.id }))
  const itemOptions = items.map((i) => ({
    value: i.id,
    label: `${i.code ? `${i.code} · ` : ''}${i.name ?? ''}`.trim(),
  }))
  const stockLocationOptions = stockLocations.map((l) => ({ value: l.id, label: l.code ?? l.id }))

  const activeDetailFetch = useRef(0)

  useEffect(() => {
    const open = () => setCreateOpen(true)
    window.addEventListener(OPEN_NEW_COUNT, open)
    return () => window.removeEventListener(OPEN_NEW_COUNT, open)
  }, [])

  /** Refetch for event handlers (never called from an effect). */
  async function refetchDetail(id: string): Promise<void> {
    const ticket = ++activeDetailFetch.current
    const res = await fetch(`/api/inventory/counts?id=${encodeURIComponent(id)}`)
    if (activeDetailFetch.current !== ticket) return
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setDetailError(
        typeof data.error === 'string' && data.error.trim() ? data.error.trim() : t('counts.failed'),
      )
      return
    }
    const data = await res.json()
    setDetail(data as StockCountDetail)
  }

  useEffect(() => {
    if (!selectedId) return
    // Same shape as the templates preview effect: the async IIFE is inline
    // so state updates happen only after the await, never in the body.
    const ticket = ++activeDetailFetch.current
    const id = selectedId
    ;(async () => {
      const res = await fetch(`/api/inventory/counts?id=${encodeURIComponent(id)}`)
      if (activeDetailFetch.current !== ticket) return
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setDetailError(
          typeof data.error === 'string' && data.error.trim() ? data.error.trim() : t('counts.failed'),
        )
        return
      }
      const data = await res.json()
      setDetail(data as StockCountDetail)
    })()
    return () => {
      activeDetailFetch.current += 1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const columns: PagedColumn<StockCountSummary>[] = [
    { key: 'date', header: t('counts.columns.date'), cell: (r) => r.countedOn, search: (r) => r.countedOn },
    {
      key: 'location',
      header: t('counts.columns.location'),
      cell: (r) => r.locationName ?? '—',
      search: (r) => `${r.locationName ?? ''} ${r.memo ?? ''}`,
    },
    {
      key: 'status',
      header: t('counts.columns.status'),
      cell: (r) => <StatusBadge status={r.status} label={t(`counts.statusNames.${r.status}`)} />,
      search: (r) => r.status,
    },
    {
      key: 'progress',
      header: t('counts.columns.progress'),
      align: 'right',
      cell: (r) => `${r.lineCount - r.uncountedCount}/${r.lineCount}`,
    },
    {
      key: 'variance',
      header: t('counts.columns.variance'),
      align: 'right',
      cell: (r) => <span className="tabular-nums">{r.variance}</span>,
    },
  ]

  return (
    <>
      <PagedTable
        rows={counts}
        columns={columns}
        searchable
        empty={t('counts.empty')}
        rowKey={(r) => r.id}
        onRowClick={(r) => {
          setDetail(null)
          setDetailError(null)
          setSelectedId(r.id)
          router.replace(`/inventory?inventoryView=counts&countId=${encodeURIComponent(r.id)}`, { scroll: false })
        }}
        emptyAsRow
      />
      {createOpen ? (
        <CreateCountDrawer
          locationOptions={locationOptions}
          subsidiaryOptions={subsidiaryOptions}
          itemOptions={itemOptions}
          stockLocationOptions={stockLocationOptions}
          lots={lots}
          onClose={() => {
            setCreateOpen(false)
            router.replace('/inventory?inventoryView=counts')
            router.refresh()
          }}
        />
      ) : null}
      {selectedId ? (
        <UrlDrawer open closeHref="/inventory?inventoryView=counts" size="xl" title={t('counts.detail.title')}>
          {detail ? (
            <CountDetailBody
              key={`${detail.header.id}:${detail.header.status}:${detail.header.countedOn}`}
              detail={detail}
              itemOptions={itemOptions}
              stockLocationOptions={stockLocationOptions}
              canPost={canPost}
              onDone={() => {
                setSelectedId(null)
                router.replace('/inventory?inventoryView=counts')
                router.refresh()
              }}
              onChanged={() => {
                if (!selectedId) return
                setDetailError(null)
                void refetchDetail(selectedId)
                router.refresh()
              }}
            />
          ) : (
            <p className="p-1 text-sm text-slate-500">
              {detailError ? `${t('counts.failed')}: ${detailError}` : t('counts.detail.loading')}
            </p>
          )}
        </UrlDrawer>
      ) : null}
    </>
  )
}

function CreateCountDrawer({
  locationOptions,
  subsidiaryOptions,
  itemOptions,
  stockLocationOptions,
  lots,
  onClose,
}: {
  locationOptions: { value: string; label: string }[]
  subsidiaryOptions: { value: string; label: string }[]
  itemOptions: { value: string; label: string }[]
  stockLocationOptions: { value: string; label: string }[]
  lots: { id: string; item_id: string; lot_number: string }[]
  onClose: () => void
}) {
  const t = useTranslations('inventory')
  const [locationId, setLocationId] = useState('')
  const [subsidiaryId, setSubsidiaryId] = useState(subsidiaryOptions[0]?.value ?? '')
  // The count date defaults to the org's business day from the server, never
  // the browser's UTC day (tomorrow after 5pm Pacific).
  const [date, setDate] = useState(useBusinessToday())
  const [memo, setMemo] = useState('')
  const [lines, setLines] = useState<{ itemId: string; stockLocationId: string; lotId: string }[]>([
    { itemId: '', stockLocationId: '', lotId: '' },
  ])
  const [busy, setBusy] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)

  async function submit() {
    const clean = lines.filter((l) => l.itemId && l.stockLocationId)
    if (!locationId || !subsidiaryId || !date || clean.length === 0) {
      toast.error(t('counts.create.missingFields'))
      return
    }
    setBusy(true)
    setPostError(null)
    try {
      await countAction({
        action: 'create',
        locationId,
        subsidiaryId,
        date,
        memo: memo || undefined,
        lines: clean.map((l) => ({
          itemId: l.itemId,
          stockLocationId: l.stockLocationId,
          lotId: l.lotId || undefined,
        })),
      })
      toast.success(t('counts.created'))
      onClose()
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      setPostError(detail)
      toast.error(detail)
    } finally {
      setBusy(false)
    }
  }

  return (
    <UrlDrawer
      open
      closeHref="/inventory?inventoryView=counts"
      size="2xl"
      title={t('counts.create.title')}
      headerActions={
        <Button disabled={busy} onClick={submit}>
          {busy ? t('counts.creating') : t('counts.create.submit')}
        </Button>
      }
    >
      <div className="space-y-5 p-1">
        {postError ? (
          <p
            role="alert"
            className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
          >
            {t('counts.failed')}: {postError}
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className={field}>
            <Label>
              {t('counts.create.location')} <span className="text-red-500">*</span>
            </Label>
            <SearchSelect
              value={locationId}
              onChange={setLocationId}
              options={locationOptions}
              placeholder={t('counts.create.selectLocation')}
              sheetTitle={t('counts.create.location')}
              ariaLabel={t('counts.create.location')}
            />
          </div>
          <div className={field}>
            <Label>
              {t('counts.create.subsidiary')} <span className="text-red-500">*</span>
            </Label>
            <SearchSelect
              value={subsidiaryId}
              onChange={setSubsidiaryId}
              options={subsidiaryOptions}
              placeholder={t('counts.create.selectSubsidiary')}
              sheetTitle={t('counts.create.subsidiary')}
              ariaLabel={t('counts.create.subsidiary')}
            />
          </div>
          <div className={field}>
            <Label>
              {t('counts.columns.date')} <span className="text-red-500">*</span>
            </Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className={field}>
            <Label>{t('counts.columns.memo')}</Label>
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </div>
        </div>
        <div className="space-y-3">
          <Label>{t('counts.create.lines')}</Label>
          {lines.map((line, i) => {
            const lotOptions = lots
              .filter((lot) => lot.item_id === line.itemId)
              .map((lot) => ({ value: lot.id, label: lot.lot_number }))
            return (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <SearchSelect
                  value={line.itemId}
                  onChange={(v) =>
                    setLines((prev) => prev.map((p, j) => (j === i ? { ...p, itemId: v, lotId: '' } : p)))
                  }
                  options={itemOptions}
                  placeholder={t('counts.create.selectItem')}
                  sheetTitle={t('counts.columns.item')}
                  ariaLabel={t('counts.columns.item')}
                />
                <SearchSelect
                  value={line.stockLocationId}
                  onChange={(v) =>
                    setLines((prev) => prev.map((p, j) => (j === i ? { ...p, stockLocationId: v } : p)))
                  }
                  options={stockLocationOptions}
                  placeholder={t('counts.create.selectStockLocation')}
                  sheetTitle={t('counts.columns.stockLocation')}
                  ariaLabel={t('counts.columns.stockLocation')}
                />
                <SearchSelect
                  value={line.lotId}
                  onChange={(v) => setLines((prev) => prev.map((p, j) => (j === i ? { ...p, lotId: v } : p)))}
                  options={lotOptions}
                  placeholder={t('counts.create.selectLot')}
                  sheetTitle={t('counts.columns.lot')}
                  ariaLabel={t('counts.columns.lot')}
                />
                <Button
                  variant="ghost"
                  onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}
                  disabled={lines.length <= 1}
                >
                  {t('counts.create.removeLine')}
                </Button>
              </div>
            )
          })}
          <Button
            variant="secondary"
            onClick={() => setLines((prev) => [...prev, { itemId: '', stockLocationId: '', lotId: '' }])}
          >
            {t('counts.create.addLine')}
          </Button>
        </div>
      </div>
    </UrlDrawer>
  )
}

function CountDetailBody({
  detail,
  itemOptions,
  stockLocationOptions,
  canPost,
  onDone,
  onChanged,
}: {
  detail: StockCountDetail
  itemOptions: { value: string; label: string }[]
  stockLocationOptions: { value: string; label: string }[]
  canPost: boolean
  onDone: () => void
  onChanged: () => void
}) {
  const t = useTranslations('inventory')
  const [busy, setBusy] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  const [counted, setCounted] = useState<Record<string, string>>({})
  // Remount per count/status/date (parent key) resets these; no effect.
  const [countDate, setCountDate] = useState(detail.header.countedOn)

  const { header, lines } = detail
  const itemLabel = (id: string) => itemOptions.find((o) => o.value === id)?.label ?? id
  const locLabel = (id: string) => stockLocationOptions.find((o) => o.value === id)?.label ?? id

  async function run(label: string, body: Record<string, unknown>) {
    setBusy(true)
    setPostError(null)
    try {
      const res = await countAction({ ...body, countId: header.id })
      toast.success(t('counts.updated'))
      onChanged()
      return res
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // A refused lifecycle step pins its reason on the record until the
      // next submit — a toast alone lets 422s read as silence.
      setPostError(`${label}: ${msg}`)
      toast.error(msg)
      return null
    } finally {
      setBusy(false)
    }
  }

  const lineColumns: PagedColumn<(typeof lines)[number]>[] = [
    {
      key: 'item',
      header: t('counts.columns.item'),
      cell: (l) => l.itemCode ?? itemLabel(l.itemId),
      search: (l) => `${l.itemCode ?? ''} ${l.itemName ?? ''}`,
    },
    {
      key: 'loc',
      header: t('counts.columns.stockLocation'),
      cell: (l) => l.stockLocationCode ?? locLabel(l.stockLocationId),
    },
    { key: 'lot', header: t('counts.columns.lot'), cell: (l) => l.lotNumber ?? '—' },
    {
      key: 'expected',
      header: t('counts.columns.expected'),
      align: 'right',
      cell: (l) => <span className="tabular-nums">{l.expectedQuantity}</span>,
    },
    {
      key: 'counted',
      header: t('counts.columns.counted'),
      align: 'right',
      cell: (l) =>
        header.status === 'counting' && canPost && !l.adjustmentMovementId ? (
          <span className="inline-flex flex-wrap items-center gap-1">
            <Input
              inputMode="decimal"
              className="w-24 text-right tabular-nums"
              placeholder={l.countedQuantity ?? ''}
              value={counted[l.id] ?? ''}
              onChange={(e) => setCounted((prev) => ({ ...prev, [l.id]: e.target.value }))}
            />
            <Button
              size="sm"
              disabled={busy || !(counted[l.id] ?? '').trim()}
              onClick={() =>
                void run(t('counts.actions.record'), {
                  action: 'record',
                  lineId: l.id,
                  countedQuantity: (counted[l.id] ?? '').trim(),
                })
              }
            >
              {t('counts.actions.save')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              title={t('counts.actions.recountHint')}
              onClick={() => void run(t('counts.actions.recount'), { action: 'recount', lineId: l.id })}
            >
              {t('counts.actions.recount')}
            </Button>
          </span>
        ) : (
          <span className="tabular-nums">{l.countedQuantity ?? '—'}</span>
        ),
    },
    {
      key: 'variance',
      header: t('counts.columns.variance'),
      align: 'right',
      cell: (l) => <span className="tabular-nums">{l.variance ?? '—'}</span>,
    },
    {
      key: 'movement',
      header: t('counts.columns.movement'),
      cell: (l) =>
        l.adjustmentMovementId ? (
          <StatusBadge status="posted" label={t('counts.detail.postedBadge')} />
        ) : (
          <span className="text-xs text-slate-500">{t('counts.detail.unpostedBadge')}</span>
        ),
    },
  ]

  return (
    <div className="space-y-5 p-1">
      {postError ? (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {postError}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <StatusBadge status={header.status} label={t(`counts.statusNames.${header.status}`)} />
        <span className="tabular-nums">{header.countedOn}</span>
        <span>{header.locationName ?? ''}</span>
        <span className="text-slate-500">{header.subsidiaryName ?? ''}</span>
        {header.memo ? <span className="text-slate-500">{header.memo}</span> : null}
      </div>
      {canPost ? (
        <div className="flex flex-wrap items-center gap-2">
          {header.status === 'draft' ? (
            <Button size="sm" disabled={busy} onClick={() => void run(t('counts.actions.start'), { action: 'start' })}>
              {t('counts.actions.start')}
            </Button>
          ) : null}
          {header.status === 'counting' ? (
            <Button size="sm" disabled={busy} onClick={() => void run(t('counts.actions.submit'), { action: 'submit' })}>
              {t('counts.actions.submit')}
            </Button>
          ) : null}
          {header.status === 'review' ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void run(t('counts.actions.post'), { action: 'post' })}
              >
                {t('counts.actions.post')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void run(t('counts.actions.return'), { action: 'return' })}
              >
                {t('counts.actions.return')}
              </Button>
            </>
          ) : null}
          {header.status === 'draft' || header.status === 'counting' || header.status === 'review' ? (
            <>
              <span className="inline-flex items-center gap-1">
                <Input
                  type="date"
                  className="w-40"
                  value={countDate}
                  onChange={(e) => setCountDate(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || !countDate || countDate === header.countedOn}
                  onClick={() => void run(t('counts.actions.setDate'), { action: 'setDate', date: countDate })}
                >
                  {t('counts.actions.setDate')}
                </Button>
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void run(t('counts.actions.cancel'), { action: 'cancel' })}
              >
                {t('counts.actions.cancel')}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      <PagedTable
        rows={lines}
        columns={lineColumns}
        searchable
        empty={t('counts.detail.noLines')}
        rowKey={(l) => l.id}
      />
      {header.status === 'posted' || header.status === 'cancelled' ? (
        <Button size="sm" variant="secondary" onClick={onDone}>
          {t('counts.actions.close')}
        </Button>
      ) : null}
    </div>
  )
}
