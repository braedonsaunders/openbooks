'use client'

import { useBusinessToday } from '@/components/business-date-provider'
import { useRouter } from 'next/navigation'
import { useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Input, Label, SearchSelect, Select, UrlDrawer, cn } from '@openbooks/ui'
import { PagedTable, type PagedColumn } from '../../../../../components/paged-table'
import type { LineGridOption } from '../../../../../components/line-grid'

export interface RateBookLine extends Record<string, unknown> {
  itemId: string
  unitCode: string
  unitName: string
  baseQuantity: string
  costRate: string
  billRate: string
  baseUnit: string
  pricingPolicy: string
  invoicePresentation: string
  timeTypeBillRates: Record<string, string>
}

export interface RateBookItemOption {
  id: string
  code: string | null
  name: string
  kind: string
  unit: string | null
  isActive: boolean
}

interface EditableRateBookLine extends RateBookLine {
  clientKey: string
}

function addOneDay(date: string): string {
  const value = new Date(`${date}T12:00:00Z`)
  if (Number.isNaN(value.valueOf())) return ''
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}

function signature(lines: RateBookLine[]): string {
  return JSON.stringify(lines.filter((line) => line.itemId.trim() || line.unitCode.trim() || line.unitName.trim()).map((line) => ({
    itemId: line.itemId,
    unitCode: line.unitCode,
    unitName: line.unitName,
    baseQuantity: line.baseQuantity,
    costRate: line.costRate,
    billRate: line.billRate,
    baseUnit: line.baseUnit,
    pricingPolicy: line.pricingPolicy,
    invoicePresentation: line.invoicePresentation,
    timeTypeBillRates: line.timeTypeBillRates,
  })))
}

function responseError(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') return body.error
  return fallback
}

export function RateBookDrawer({
  row,
  latestEffectiveFrom,
  lines: initialLines,
  items,
  currencies,
  baseCurrency,
  multiCurrency,
  closeHref,
}: {
  row: Record<string, unknown> | null
  latestEffectiveFrom: string | null
  lines: RateBookLine[]
  items: RateBookItemOption[]
  currencies: LineGridOption[]
  baseCurrency: string
  multiCurrency: boolean
  closeHref: string
}) {
  const t = useTranslations('items.rateBookDrawer')
  const tRates = useTranslations('items.rates')
  const tSetup = useTranslations('admin.setup')
  const common = useTranslations('common')
  const router = useRouter()
  const today = useBusinessToday()
  const creating = row == null
  const [code, setCode] = useState(String(row?.code ?? ''))
  const [name, setName] = useState(String(row?.name ?? ''))
  const [currency, setCurrency] = useState(String(row?.currency ?? baseCurrency))
  const [isDefault, setIsDefault] = useState(Boolean(row?.is_default))
  const [isActive, setIsActive] = useState(row ? Boolean(row.is_active) : true)
  const [effectiveFrom, setEffectiveFrom] = useState(latestEffectiveFrom ? addOneDay(latestEffectiveFrom) : today)
  const nextLineKey = useRef(initialLines.length)
  const [lines, setLines] = useState<EditableRateBookLine[]>(() => initialLines.map((line, index) => ({
    ...line,
    clientKey: `existing-${index}`,
  })))
  const [tableGeneration, setTableGeneration] = useState(0)
  const [activeTab, setActiveTab] = useState<'overview' | 'rates'>('overview')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const initialLineSignature = useMemo(() => signature(initialLines), [initialLines])
  const ratesChanged = signature(lines) !== initialLineSignature

  const itemOptions = useMemo<LineGridOption[]>(() => items.map((item) => ({
    value: item.id,
    label: `${item.code && item.code !== item.name ? `${item.code} · ` : ''}${item.name}${item.isActive ? '' : ` · ${t('inactive')}`}`,
  })), [items, t])
  function updateLine(clientKey: string, patch: Partial<RateBookLine>) {
    setError('')
    setLines((current) => current.map((line) => {
      if (line.clientKey !== clientKey) return line
      const next = { ...line, ...patch }
      if (!patch.itemId || patch.itemId === line.itemId) return next
      const item = items.find((candidate) => candidate.id === patch.itemId)
      const unit = item?.kind === 'labor' ? 'hour' : (item?.unit?.trim() || 'each')
      return {
        ...next,
        unitCode: unit.toLowerCase(),
        unitName: unit.charAt(0).toUpperCase() + unit.slice(1),
        baseQuantity: '1',
        baseUnit: unit.toLowerCase(),
        timeTypeBillRates: {},
      }
    }))
  }

  function addLine() {
    setError('')
    setLines((current) => [
      ...current,
      { ...emptyRateBookLine(), clientKey: `new-${nextLineKey.current++}` },
    ])
    // The shared table owns its search query; remounting only when Add is used
    // clears a stale filter so the new blank row is always visible.
    setTableGeneration((generation) => generation + 1)
  }

  function removeLine(clientKey: string) {
    setError('')
    setLines((current) => current.filter((line) => line.clientKey !== clientKey))
  }

  const columns: PagedColumn<EditableRateBookLine>[] = [
    {
      key: 'item',
      header: t('item'),
      search: (line) => itemOptions.find((option) => option.value === line.itemId)?.label ?? '',
      cell: (line) => (
        <div className="min-w-56">
          <SearchSelect
            value={line.itemId}
            onChange={(itemId) => updateLine(line.clientKey, { itemId })}
            options={itemOptions}
            ariaLabel={t('item')}
            sheetTitle={t('item')}
          />
        </div>
      ),
    },
    {
      key: 'unitCode', header: tRates('unitCode'), search: (line) => line.unitCode,
      cell: (line) => <Input className="min-w-24" value={line.unitCode} onChange={(event) => updateLine(line.clientKey, { unitCode: event.target.value })} />,
    },
    {
      key: 'unitName', header: tRates('unitName'), search: (line) => line.unitName,
      cell: (line) => <Input className="min-w-32" value={line.unitName} onChange={(event) => updateLine(line.clientKey, { unitName: event.target.value })} />,
    },
    {
      key: 'baseQuantity', header: tRates('baseQuantity'), align: 'right',
      cell: (line) => <Input className="min-w-24 text-right tabular-nums" inputMode="decimal" value={line.baseQuantity} onChange={(event) => updateLine(line.clientKey, { baseQuantity: event.target.value })} />,
    },
    {
      key: 'costRate', header: tRates('costRate'), align: 'right',
      cell: (line) => <Input className="min-w-24 text-right tabular-nums" inputMode="decimal" value={line.costRate} onChange={(event) => updateLine(line.clientKey, { costRate: event.target.value })} />,
    },
    {
      key: 'billRate', header: tRates('billRate'), align: 'right',
      cell: (line) => <Input className="min-w-24 text-right tabular-nums" inputMode="decimal" value={line.billRate} onChange={(event) => updateLine(line.clientKey, { billRate: event.target.value })} />,
    },
    {
      key: 'baseUnit', header: tRates('baseUnit'), search: (line) => line.baseUnit,
      cell: (line) => <Input className="min-w-24" value={line.baseUnit} onChange={(event) => updateLine(line.clientKey, { baseUnit: event.target.value })} />,
    },
    {
      key: 'policy', header: tRates('policy'),
      cell: (line) => (
        <Select className="min-w-40" value={line.pricingPolicy} onChange={(event) => updateLine(line.clientKey, { pricingPolicy: event.target.value })}>
          <option value="capped_ladder">{tRates('policies.capped_ladder')}</option>
          <option value="lowest_cost">{tRates('policies.lowest_cost')}</option>
        </Select>
      ),
    },
    {
      key: 'presentation', header: tRates('presentation'),
      cell: (line) => (
        <Select className="min-w-44" value={line.invoicePresentation} onChange={(event) => updateLine(line.clientKey, { invoicePresentation: event.target.value })}>
          <option value="rate_components">{tRates('presentations.rate_components')}</option>
          <option value="summary">{tRates('presentations.summary')}</option>
        </Select>
      ),
    },
    {
      key: 'actions', header: common('labels.actions'), align: 'right',
      cell: (line) => (
        <Button type="button" variant="ghost" size="sm" onClick={() => removeLine(line.clientKey)} aria-label={common('actions.remove')}>
          <Trash2 size={15} />
        </Button>
      ),
    },
  ]

  async function save() {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/item-rate-books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: row?.id,
          code,
          name,
          ...(multiCurrency ? { currency } : {}),
          isDefault,
          isActive,
          replaceRates: ratesChanged,
          effectiveFrom,
          lines: lines.map(({ clientKey: _clientKey, ...line }) => line),
        }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        const message = responseError(body, common('feedback.saveFailed'))
        setError(message)
        toast.error(message)
        return
      }
      toast.success(creating ? tSetup('created') : tSetup('updated'))
      router.push(closeHref)
      router.refresh()
    } catch {
      const message = common('feedback.saveFailed')
      setError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="full"
      title={creating ? t('newTitle') : t('editTitle', { name: String(row?.name ?? '') })}
      description={t('description')}
      subtabs={
        <nav className="-mb-px flex flex-wrap gap-1" aria-label={t('tabsAria')}>
          {(['overview', 'rates'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                'border-b-2 px-3 py-3 text-sm font-medium transition-colors',
                activeTab === tab
                  ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200',
              )}
            >
              {t(`tabs.${tab}`)}
            </button>
          ))}
        </nav>
      }
      headerActions={<Button disabled={busy} onClick={save}>{busy ? common('actions.saving') : creating ? common('actions.create') : common('actions.save')}</Button>}
    >
      <div className="space-y-6">
        {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error}</p> : null}
        {activeTab === 'overview' ? <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5"><Label>{tSetup('fields.code')}</Label><Input value={code} disabled={!creating} onChange={(event) => setCode(event.target.value)} /></div>
          <div className="space-y-1.5"><Label>{tSetup('fields.name')}</Label><Input value={name} onChange={(event) => setName(event.target.value)} /></div>
          <div className="space-y-1.5"><Label>{tSetup('fields.currency')}</Label>{multiCurrency ? (
            <SearchSelect value={currency} onChange={setCurrency} options={currencies} ariaLabel={tSetup('fields.currency')} sheetTitle={tSetup('fields.currency')} />
          ) : <div className="flex h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-mono dark:border-slate-800 dark:bg-slate-900">{currency}</div>}</div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />{tSetup('fields.isDefault')}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />{tSetup('fields.isActive')}</label>
        </section> : null}

        {activeTab === 'rates' ? <section className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('ratesTitle')}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('ratesHelp')}</p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-44 space-y-1.5"><Label>{tRates('effectiveFrom')}</Label><Input type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></div>
              <Button type="button" variant="outline" onClick={addLine}><Plus size={15} />{t('addItem')}</Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <PagedTable<EditableRateBookLine>
              key={tableGeneration}
              pageSize={10}
              searchable
              emptyAsRow
              empty={common('empty.title')}
              rowKey={(line) => line.clientKey}
              columns={columns}
              rows={lines}
            />
          </div>
          {!ratesChanged && !creating ? <p className="text-xs text-slate-500 dark:text-slate-400">{t('unchangedHelp')}</p> : null}
        </section> : null}
      </div>
    </UrlDrawer>
  )
}

function emptyRateBookLine(): RateBookLine {
  return {
    itemId: '',
    unitCode: '',
    unitName: '',
    baseQuantity: '1',
    costRate: '0',
    billRate: '0',
    baseUnit: '',
    pricingPolicy: 'capped_ladder',
    invoicePresentation: 'rate_components',
    timeTypeBillRates: {},
  }
}
