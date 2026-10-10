'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Drawer, Label, Select, Input } from '@openbooks/ui'
import { DrawerSublist, SublistAddButton } from '@/components/drawer-sublist'
import { useBusinessToday } from '@/components/business-date-provider'
import { LineGrid, type LineGridColumn } from '@/components/line-grid'
import { PagedTable } from '@/components/paged-table'
import { useSublistRows } from '@/components/drawer-sublist'
import { confirmDialog } from '@/lib/confirm'
import { promptDialog } from '@/lib/prompt'

interface PriceBreak extends Record<string, unknown> { id?: string; minimumQuantity: string; unitPrice: string }
interface Level { id: string; code: string; name: string; pricing_method: string; percentage: string | null; cost_basis: string | null; is_base: boolean }
interface Customer { id: string; display_name: string }
interface Schedule {
  id: string; price_level_id: string | null; customer_id: string | null; currency: string;
  quantity_basis: 'line_quantity' | 'overall_item_quantity'; effective_from: string; effective_to: string | null;
  is_active: boolean; revision: number; supersedes_id: string | null; change_reason: string | null;
  price_level_name: string | null; customer_name: string | null; breaks: PriceBreak[]
  inheritedFrom?: { familyId: string; familyCode: string | null; familyName: string | null } | null
}
interface PricingData { levels: Level[]; customers: Customer[]; currencies: { code: string; name: string }[]; baseCurrency: string | null; schedules: Schedule[]; inherited?: Schedule[] }

function responseError(payload: unknown, fallback: string) {
  return payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : fallback
}

/**
 * The price matrix for one item or one family. A variant additionally lists
 * the family schedules it inherits as read-only rows: overriding one copies
 * it into the variant's own schedules, and deleting that copy returns the
 * variant to inheritance. Exactly one of itemId / familyId is set.
 */
export function ItemPriceMatrixEditor({ itemId, familyId, canManage }: { itemId?: string; familyId?: string | null; canManage: boolean }) {
  const subjectPath = familyId ? `/api/item-families/${familyId}/prices` : `/api/items/${itemId}/prices`
  const t = useTranslations('items.pricingMatrix')
  const common = useTranslations('common')
  const today = useBusinessToday()
  const [data, setData] = useState<PricingData | null>(null)
  const [editingId, setEditingId] = useState<string | 'new' | null>(null)
  const [createRequestId, setCreateRequestId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [scope, setScope] = useState<'base' | 'level' | 'customer'>('base')
  const [priceLevelId, setPriceLevelId] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [currency, setCurrency] = useState('')
  const [quantityBasis, setQuantityBasis] = useState<'line_quantity' | 'overall_item_quantity'>('line_quantity')
  const [effectiveFrom, setEffectiveFrom] = useState(today)
  const [effectiveTo, setEffectiveTo] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [breaks, setBreaks] = useState<PriceBreak[]>([{ minimumQuantity: '1', unitPrice: '0' }])
  const [editingRevision, setEditingRevision] = useState(0)
  const [reason, setReason] = useState('')

  // Fetch chain rather than an async body: every state update below sits in a
  // promise continuation (the fetch response), never synchronously in the
  // effect that calls this. The promise is returned so callers can await it.
  const load = useCallback(() => {
    return fetch(subjectPath).then(async (response) => {
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        const message = responseError(payload, t('loadFailed'))
        setError(message)
        toast.error(message)
        return
      }
      const next = await response.json() as PricingData
      setData(next)
      setError('')
      setCurrency((current) => current || next.baseCurrency || next.currencies[0]?.code || '')
    })
  }, [subjectPath, t])
  useEffect(() => { void load() }, [load])

  const breakColumns = useMemo<LineGridColumn<PriceBreak>[]>(() => [
    { key: 'minimumQuantity', label: t('minimumQuantity'), width: 'minmax(160px,1fr)', type: 'decimal', decimalScale: 4, required: true },
    { key: 'unitPrice', label: t('unitPrice'), width: 'minmax(160px,1fr)', type: 'amount', required: true },
  ], [t])

  function beginNew(target: 'base' | 'level' | 'customer' = 'base') {
    setEditingId('new'); setCreateRequestId(crypto.randomUUID()); setScope(target); setPriceLevelId(data?.levels.find((level) => !level.is_base)?.id ?? ''); setCustomerId('')
    setCurrency(data?.baseCurrency ?? data?.currencies[0]?.code ?? ''); setQuantityBasis('line_quantity'); setEffectiveFrom(today); setEffectiveTo(''); setIsActive(true)
    setBreaks([{ minimumQuantity: '1', unitPrice: '0' }]); setEditingRevision(0); setReason(''); setError('')
  }
  function beginEdit(schedule: Schedule) {
    setEditingId(schedule.id)
    setScope(schedule.customer_id ? 'customer' : schedule.price_level_id && !data?.levels.find((level) => level.id === schedule.price_level_id)?.is_base ? 'level' : 'base')
    setPriceLevelId(schedule.price_level_id ?? ''); setCustomerId(schedule.customer_id ?? ''); setCurrency(schedule.currency)
    setQuantityBasis(schedule.quantity_basis); setEffectiveFrom(schedule.effective_from); setEffectiveTo(schedule.effective_to ?? '')
    setIsActive(schedule.is_active); setBreaks(schedule.breaks.length ? schedule.breaks : [{ minimumQuantity: '1', unitPrice: '0' }])
    setEditingRevision(schedule.revision); setReason(''); setError('')
  }

  // A schedule that already prices effective dates keeps its history: the
  // server inserts a corrected version (or a prospective successor) and
  // requires a reason when the new prices reach the past.
  const editingSchedule = editingId !== null && editingId !== 'new' ? data?.schedules.find((schedule) => schedule.id === editingId) ?? null : null
  const reasonVisible = editingSchedule !== null && editingSchedule.effective_from <= today

  async function save() {
    setBusy(true); setError('')
    try {
      const response = await fetch(subjectPath, {
        method: editingId === 'new' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(editingId === 'new' ? { 'Idempotency-Key': createRequestId } : {}) },
        body: JSON.stringify({
          ...(editingId !== 'new' ? { id: editingId, revision: editingRevision } : {}),
          priceLevelId: scope === 'level' ? priceLevelId : scope === 'base' ? data?.levels.find((level) => level.is_base)?.id ?? null : null,
          customerId: scope === 'customer' ? customerId : null,
          currency, quantityBasis, effectiveFrom, effectiveTo: effectiveTo || null, isActive, breaks,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        const message = responseError(payload, t('saveFailed')); setError(message); toast.error(message); await load()
        // A 409 names a conflict the form cannot merge (a stale revision or
        // an overlapping scope): the server's remedy is to reload, so the
        // editor closes instead of offering a retry on a dead token.
        if (response.status === 409) { setEditingId(null); setCreateRequestId('') }
        return
      }
      toast.success(t('saved')); setEditingId(null); setCreateRequestId(''); await load()
    } catch {
      setError(t('saveFailed')); toast.error(t('saveFailed'))
    } finally { setBusy(false) }
  }

  async function remove(schedule: Schedule) {
    // An effective schedule is history: ending it keeps the row with an
    // effective-to date, so the operator names the reason up front. A
    // never-effective schedule never priced anything and is deleted outright.
    const params = new URLSearchParams({ schedule: schedule.id, revision: String(schedule.revision) })
    if (schedule.effective_from <= today) {
      const endReason = await promptDialog({ title: t('endDateTitle'), label: t('endDateReasonLabel'), confirmLabel: common('actions.delete') })
      if (!endReason) return
      params.set('reason', endReason)
    } else if (!(await confirmDialog({ message: t('confirmDelete'), confirmLabel: common('actions.delete'), tone: 'danger' }))) return
    const response = await fetch(`${subjectPath}?${params}`, { method: 'DELETE' })
    if (!response.ok) { const payload = await response.json().catch(() => null); toast.error(responseError(payload, t('deleteFailed'))); await load(); return }
    const outcome = await response.json().catch(() => null)
    toast.success(outcome && typeof outcome === 'object' && (outcome as { endDated?: unknown }).endDated ? t('ended') : t('deleted')); await load()
  }

  const targetLabel = (schedule: Schedule) => schedule.customer_name
    ? t('customerTarget', { customer: schedule.customer_name })
    : schedule.price_level_name ?? t('baseTarget')

  /** An inherited row is shadowed when the variant holds its own schedule for the same scope and currency. */
  const scopeKey = (schedule: Schedule) => `${schedule.customer_id ?? ''}|${schedule.price_level_id ?? ''}|${schedule.currency}`
  const ownKeys = useMemo(() => new Set((data?.schedules ?? []).map(scopeKey)), [data])
  const inherited = useMemo(() => data?.inherited ?? [], [data])
  /**
   * One price-schedule table: own rows first, then the family rows this
   * variant inherits. A second stacked table would hide inheritance beside
   * the list instead of inside it, so the source badge carries the split.
   */
  type CombinedRow = Schedule & { inheritedRow: boolean }
  const combinedRows = useMemo<CombinedRow[]>(
    () => [
      ...(data?.schedules ?? []).map((schedule) => ({ ...schedule, inheritedRow: false })),
      ...inherited.map((schedule) => ({ ...schedule, inheritedRow: true })),
    ],
    [data, inherited],
  )

  /**
   * Override an inherited family row: open the create form prefilled from
   * the family schedule, so the variant's own schedule starts as a copy and
   * the operator changes only what differs. Only variants reach this button —
   * family subjects never receive inherited rows.
   */
  function beginOverride(schedule: Schedule) {
    setEditingId('new'); setCreateRequestId(crypto.randomUUID())
    setScope(schedule.customer_id ? 'customer' : schedule.price_level_id && !data?.levels.find((level) => level.id === schedule.price_level_id)?.is_base ? 'level' : 'base')
    setPriceLevelId(schedule.price_level_id ?? ''); setCustomerId(schedule.customer_id ?? ''); setCurrency(schedule.currency)
    setQuantityBasis(schedule.quantity_basis); setEffectiveFrom(schedule.effective_from); setEffectiveTo(schedule.effective_to ?? '')
    setIsActive(schedule.is_active); setBreaks(schedule.breaks.length ? schedule.breaks : [{ minimumQuantity: '1', unitPrice: '0' }])
    setEditingRevision(0); setReason(''); setError('')
  }

  const scheduleText = (row: CombinedRow) => `${targetLabel(row)} ${row.currency} ${row.effective_from} ${row.breaks.map((entry) => `${entry.minimumQuantity} ${entry.unitPrice}`).join(' ')}`
  const list = useSublistRows(combinedRows, scheduleText)

  return (
    <DrawerSublist
      title={t('title')}
      description={familyId ? t('familyDescription') : t('description')}
      action={canManage ? <SublistAddButton label={t('addSchedule')} onClick={() => beginNew('base')} /> : undefined}
      alert={editingId === null && error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      search={combinedRows.length ? { value: list.query, onChange: list.setQuery, placeholder: t('search') } : undefined}
    >
      <PagedTable
        rows={list.filtered} rowKey={(row) => `${row.inheritedRow ? 'inherited' : 'own'}:${row.id}`} emptyAsRow
        empty={<span>{t('empty')}</span>} onRowClick={canManage ? (row) => { if (!row.inheritedRow) beginEdit(row) } : undefined}
        columns={[
          { key: 'target', header: t('target'), cell: targetLabel, search: targetLabel },
          { key: 'currency', header: t('currency'), cell: (row) => row.currency, search: (row) => row.currency },
          { key: 'basis', header: t('quantityBasis'), cell: (row) => t(row.quantity_basis === 'overall_item_quantity' ? 'quantityBases.overallItem' : 'quantityBases.line') },
          { key: 'dates', header: t('effective'), cell: (row) => `${row.effective_from} → ${row.effective_to ?? '∞'}` },
          { key: 'breaks', header: t('breaks'), cell: (row) => row.breaks.map((entry) => `${entry.minimumQuantity}+: ${row.currency} ${entry.unitPrice}`).join(' · '), search: (row) => row.breaks.map((entry) => `${entry.minimumQuantity} ${entry.unitPrice}`).join(' ') },
          {
            key: 'source', header: t('source'), cell: (row) => {
              if (!row.inheritedRow) return null
              const shadowed = ownKeys.has(scopeKey(row))
              return (
                <span className="flex items-center gap-1.5">
                  <Badge variant={shadowed ? 'secondary' : 'outline'}>
                    {shadowed ? t('overriddenBadge') : t('inheritedBadge', { family: row.inheritedFrom?.familyName ?? '' })}
                  </Badge>
                </span>
              )
            },
          },
          { key: 'status', header: common('labels.status'), cell: (row) => <Badge variant={row.is_active ? 'success' : 'secondary'}>{row.is_active ? common('status.active') : common('status.inactive')}</Badge> },
          {
            key: 'actions', header: '', cell: (row) => {
              if (row.inheritedRow) {
                return canManage && !ownKeys.has(scopeKey(row)) ? <Button variant="ghost" size="sm" onClick={() => beginOverride(row)}>{t('override')}</Button> : null
              }
              return canManage ? <Button variant="ghost" size="sm" onClick={(event) => { event.stopPropagation(); void remove(row) }}>{common('actions.delete')}</Button> : null
            },
          },
        ]}
      />

      <Drawer
        open={editingId !== null && canManage}
        onClose={() => { if (!busy) setEditingId(null) }}
        stacked
        size="lg"
        title={editingId === 'new' ? t('addSchedule') : t('editSchedule')}
        footer={(
          <>
            <Button variant="outline" disabled={busy} onClick={() => setEditingId(null)}>{common('actions.cancel')}</Button>
            <Button disabled={busy || !currency || (scope === 'level' && !priceLevelId) || (scope === 'customer' && !customerId)} onClick={save}>{busy ? common('actions.saving') : common('actions.save')}</Button>
          </>
        )}
      >
        <fieldset disabled={busy} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label>{t('scope')}</Label><Select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="base">{t('scopes.base')}</option><option value="level">{t('scopes.level')}</option><option value="customer">{t('scopes.customer')}</option></Select></div>
            {scope === 'level' ? <div className="space-y-1"><Label>{t('priceLevel')}</Label><Select value={priceLevelId} onChange={(event) => setPriceLevelId(event.target.value)}>{data?.levels.filter((level) => !level.is_base).map((level) => <option key={level.id} value={level.id}>{level.name}</option>)}</Select>{data && data.levels.filter((level) => !level.is_base).length === 0 ? <p className="text-xs text-slate-500 dark:text-slate-400">{t('noLevelsHint')}</p> : null}</div> : null}
            {scope === 'customer' ? <div className="space-y-1"><Label>{t('customer')}</Label><Select value={customerId} onChange={(event) => setCustomerId(event.target.value)}><option value="">{t('selectCustomer')}</option>{data?.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.display_name}</option>)}</Select></div> : null}
            <div className="space-y-1"><Label>{t('currency')}</Label><Select value={currency} onChange={(event) => setCurrency(event.target.value)}>{data?.currencies.map((entry) => <option key={entry.code} value={entry.code}>{entry.code} · {entry.name}</option>)}</Select></div>
            <div className="space-y-1"><Label>{t('quantityBasis')}</Label><Select value={quantityBasis} onChange={(event) => setQuantityBasis(event.target.value as typeof quantityBasis)}><option value="line_quantity">{t('quantityBases.line')}</option><option value="overall_item_quantity">{t('quantityBases.overallItem')}</option></Select></div>
            <div className="space-y-1"><Label>{t('effectiveFrom')}</Label><Input type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></div>
            <div className="space-y-1"><Label>{t('effectiveTo')}</Label><Input type="date" value={effectiveTo} onChange={(event) => setEffectiveTo(event.target.value)} /></div>
            <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />{common('status.active')}</label>
          </div>
          {reasonVisible ? (
            <div className="space-y-1">
              <Label>{t('changeReason')}</Label>
              <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t('changeReasonPlaceholder')} />
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('changeReasonHint')}</p>
            </div>
          ) : null}
          <div><h4 className="mb-1 text-sm font-medium">{t('breaksTitle')}</h4><p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{t('breaksDescription')}</p>
            <LineGrid columns={breakColumns} rows={breaks} onRowsChange={setBreaks} emptyRow={() => ({ minimumQuantity: '', unitPrice: '' })} minRows={1} addLabel={t('addBreak')} addPlacement="top" />
          </div>
          {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        </fieldset>
      </Drawer>
    </DrawerSublist>
  )
}
