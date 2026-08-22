'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { BookOpen, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, Select } from '@openbooks/ui'
import { useBusinessToday } from '../../../components/business-date-provider'
import { PagedTable } from '../../../components/paged-table'

interface RateRow {
  id: string
  rate: string
  currency: string
  basis: 'hour' | 'year'
  annual_hours: string
  effective_from: string
  effective_to: string | null
  notes: string | null
  is_current: boolean
}

interface RatesResponse {
  rates: RateRow[]
  currencies: string[]
  defaultCurrency: string
}

/** Confidential employee compensation history, gated by admin.setup.manage. */
export function EmployeeWageRates({ partyId }: { partyId: string }) {
  const t = useTranslations('parties.drawer.wages')
  const tc = useTranslations('common')
  const format = useFormatter()
  const today = useBusinessToday()
  const [data, setData] = useState<RatesResponse | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rate, setRate] = useState('')
  const [currency, setCurrency] = useState('')
  const [basis, setBasis] = useState<'hour' | 'year'>('hour')
  const [annualHours, setAnnualHours] = useState('2080')
  const [effectiveFrom, setEffectiveFrom] = useState(today)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadError(false)
    try {
      const response = await fetch(`/api/admin/setup/labor-costing?employee=${encodeURIComponent(partyId)}`, { signal })
      if (!response.ok) throw new Error('load failed')
      const next = (await response.json()) as RatesResponse
      setData(next)
      setCurrency((current) => current && next.currencies.includes(current) ? current : next.defaultCurrency)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setLoadError(true)
      setData(null)
    }
  }, [partyId])

  useEffect(() => {
    setData(null)
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  async function mutate(payload: Record<string, unknown>, successMessage: string) {
    setBusy(true)
    try {
      const response = await fetch('/api/admin/setup/labor-costing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw new Error('mutation failed')
      await load()
      toast.success(successMessage)
      return true
    } catch {
      toast.error(t('saveFailed'))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function addRate() {
    const amount = Number(rate)
    if (rate.trim() === '' || !Number.isFinite(amount) || amount < 0) {
      toast.error(t('rateRequired'))
      return
    }
    const hours = Number(annualHours)
    if (basis === 'year' && (!Number.isFinite(hours) || hours <= 0)) {
      toast.error(t('annualHoursRequired'))
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      toast.error(t('effectiveFromRequired'))
      return
    }
    const saved = await mutate({
      action: 'save-rate',
      employeePartyId: partyId,
      tradeId: null,
      jobTitle: null,
      departmentId: null,
      subsidiaryId: null,
      currency: currency || data?.defaultCurrency,
      rate: amount,
      basis,
      annualHours: basis === 'year' ? hours : 2080,
      effectiveFrom,
    }, t('saved'))
    if (saved) setRate('')
  }

  const formatDate = (value: string) => format.dateTime(new Date(`${value}T12:00:00Z`), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('hint')}</p>
        </div>
        <Link
          href="/docs/labor-costing"
          className="flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
        >
          <BookOpen size={13} aria-hidden /> {t('documentation')}
        </Link>
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-900/60">
        <div>
          <Label htmlFor="employee-wage-rate">{t('rate')}</Label>
          <Input
            id="employee-wage-rate"
            type="number"
            min="0"
            step="0.0001"
            className="w-32"
            value={rate}
            onChange={(event) => setRate(event.target.value)}
          />
        </div>
        {data && data.currencies.length > 1 ? (
          <div>
            <Label htmlFor="employee-wage-currency">{t('currency')}</Label>
            <Select
              id="employee-wage-currency"
              className="w-28"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              {data.currencies.map((code) => <option key={code} value={code}>{code}</option>)}
            </Select>
          </div>
        ) : null}
        <div>
          <Label htmlFor="employee-wage-basis">{t('basis')}</Label>
          <Select
            id="employee-wage-basis"
            className="w-36"
            value={basis}
            onChange={(event) => setBasis(event.target.value as 'hour' | 'year')}
          >
            <option value="hour">{t('perHour')}</option>
            <option value="year">{t('perYear')}</option>
          </Select>
        </div>
        {basis === 'year' ? (
          <div>
            <Label htmlFor="employee-wage-annual-hours">{t('annualHours')}</Label>
            <Input
              id="employee-wage-annual-hours"
              type="number"
              min="0.0001"
              step="0.01"
              className="w-32"
              value={annualHours}
              onChange={(event) => setAnnualHours(event.target.value)}
            />
          </div>
        ) : null}
        <div>
          <Label htmlFor="employee-wage-effective-from">{t('effectiveFrom')}</Label>
          <Input
            id="employee-wage-effective-from"
            type="date"
            className="w-40"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
          />
        </div>
        <Button size="sm" onClick={() => void addRate()} disabled={busy || data === null}>
          <Plus size={14} aria-hidden /> {t('add')}
        </Button>
      </div>

      {loadError ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-center dark:border-rose-900 dark:bg-rose-950/30">
          <p className="text-sm text-rose-700 dark:text-rose-300">{tc('feedback.loadFailed')}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void load()}>
            {tc('actions.retry')}
          </Button>
        </div>
      ) : data === null ? (
        <p className="py-6 text-center text-sm text-slate-400">{tc('feedback.loading')}</p>
      ) : (
        <PagedTable
          rows={data.rates}
          rowKey={(row) => row.id}
          rowClassName={(row) => row.is_current ? 'bg-teal-50/80 dark:bg-teal-950/30' : undefined}
          searchable
          pageSize={10}
          empty={<p className="py-6 text-center text-sm text-slate-400">{t('empty')}</p>}
          columns={[
            {
              key: 'rate',
              header: t('rate'),
              align: 'right',
              search: (row) => row.rate,
              cell: (row) => (
                <span className="inline-flex items-center gap-2 tabular-nums">
                  {format.number(Number(row.rate), {
                    style: 'currency',
                    currency: row.currency,
                    currencyDisplay: 'code',
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 4,
                  })}
                  {row.is_current ? <Badge variant="success">{t('current')}</Badge> : null}
                </span>
              ),
            },
            {
              key: 'basis',
              header: t('basis'),
              search: (row) => row.basis === 'year' ? t('perYear') : t('perHour'),
              cell: (row) => row.basis === 'year' ? t('perYear') : t('perHour'),
            },
            {
              key: 'from',
              header: t('effectiveFrom'),
              search: (row) => row.effective_from,
              cell: (row) => <span className="tabular-nums">{formatDate(row.effective_from)}</span>,
            },
            {
              key: 'to',
              header: t('effectiveTo'),
              search: (row) => row.effective_to ?? '',
              cell: (row) => <span className="tabular-nums">{row.effective_to ? formatDate(row.effective_to) : '—'}</span>,
            },
            {
              key: 'actions',
              header: tc('labels.actions'),
              align: 'right',
              cell: (row) => (
                <div className="flex justify-end gap-1">
                  {row.is_current ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(t('confirmEnd'))) {
                          void mutate({ action: 'end-rate', id: row.id, effectiveTo: today }, t('ended'))
                        }
                      }}
                    >
                      {t('endToday')}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t('delete')}
                    onClick={() => {
                      if (window.confirm(t('confirmDelete'))) {
                        void mutate({ action: 'delete-rate', id: row.id }, t('deleted'))
                      }
                    }}
                  >
                    <Trash2 size={14} aria-hidden />
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}
    </section>
  )
}
