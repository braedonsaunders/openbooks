'use client'

import { type PayrollAmountRounding } from '@openbooks/engine/src/projects/payroll-wage-rounding.ts'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { BookOpen, SlidersHorizontal, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Drawer, Input, Label, Select } from '@openbooks/ui'
import { DrawerSublist, SublistAddButton, SublistLoadError, SublistLoading, useSublistRows } from '../../../components/drawer-sublist'
import { useBusinessToday } from '../../../components/business-date-provider'
import { useMoney } from '../../../components/money-provider'
import { PagedTable } from '../../../components/paged-table'
import { canonicalDecimal, compareDecimal } from '../../../lib/exact-decimal'
import { confirmDialog } from '@/lib/confirm'
import {
  PAY_RATE_BASES,
  annualPayRate,
  hourlyPayRate,
  isPayRateBasis,
  isTimePayRateBasis,
  type PayRateBasis,
} from '@openbooks/engine/projects/pay-rate-basis'

interface RateRow {
  id: string
  rate: string
  currency: string
  basis: PayRateBasis
  payroll_rate_scale: number
  payroll_amount_rounding: PayrollAmountRounding
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

const BASIS_LABEL_KEYS: Record<PayRateBasis, 'perHour' | 'perWeek' | 'perBiweekly' | 'perSemimonth' | 'perMonth' | 'perYear'> = {
  hour: 'perHour',
  week: 'perWeek',
  biweekly: 'perBiweekly',
  semimonth: 'perSemimonth',
  month: 'perMonth',
  year: 'perYear',
}

/**
 * The hourly and annual equivalents of a stored rate, through the shared
 * pay-rate conversion. A row whose annual hours cannot convert has none.
 */
function rateEquivalents(row: RateRow): { hourly: string; annual: string } | null {
  try {
    return {
      hourly: hourlyPayRate(row.rate, row.basis, row.annual_hours),
      annual: annualPayRate(row.rate, row.basis, row.annual_hours),
    }
  } catch {
    return null
  }
}

/** Confidential employee compensation history, gated by admin.setup.manage. */
export function EmployeeWageRates({ partyId }: { partyId: string }) {
  const t = useTranslations('parties.drawer.wages')
  const tc = useTranslations('common')
  const format = useFormatter()
  const { money } = useMoney()
  const today = useBusinessToday()
  const [data, setData] = useState<RatesResponse | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  // A refused save/end/delete stays visible on the record until the next
  // mutation attempt — a 4-second toast alone once let a refused change read as a
  // silent no-op. The detail is the server's refusal text when present.
  const [actionError, setActionError] = useState<string | null>(null)
  const [rate, setRate] = useState('')
  const [currency, setCurrency] = useState('')
  const [basis, setBasis] = useState<PayRateBasis>('hour')
  const [annualHours, setAnnualHours] = useState('2080')
  const [effectiveFrom, setEffectiveFrom] = useState(today)
  const [adding, setAdding] = useState(false)

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body. The loading reset lives
  // with the triggers (below, and the mutation reload) instead of a mount
  // effect.
  const load = useCallback((signal?: AbortSignal) => {
    fetch(`/api/admin/setup/labor-costing?employee=${encodeURIComponent(partyId)}`, { signal })
      .then((response) => {
        if (!response.ok) throw new Error('load failed')
        return (response.json() as Promise<RatesResponse>).then((next) => {
          setData(next)
          setCurrency((current) => (current && next.currencies.includes(current) ? current : next.defaultCurrency))
        })
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setLoadError(true)
        setData(null)
      })
  }, [partyId])

  // Reset when the employee changes, during render (same committed values, no
  // extra render — and no one-commit flash of a stale error banner).
  const [prevPartyId, setPrevPartyId] = useState(partyId)
  if (prevPartyId !== partyId) {
    setPrevPartyId(partyId)
    setData(null)
    setLoadError(false)
  }

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  async function mutate(payload: Record<string, unknown>, successMessage: string) {
    setBusy(true)
    setActionError(null)
    try {
      const response = await fetch('/api/admin/setup/labor-costing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        let detail: string | null = null
        try {
          const body = (await response.json()) as { error?: unknown }
          if (typeof body.error === 'string' && body.error.trim()) detail = body.error.trim()
        } catch {
          detail = null
        }
        setActionError(detail ?? t('saveFailed'))
        throw new Error('mutation failed')
      }
      setLoadError(false)
      await load()
      toast.success(successMessage)
      return true
    } catch {
      // A transport failure reaches here with no server detail pinned yet —
      // still leave the generic refusal on the record, not only the toast.
      setActionError((current) => current ?? t('saveFailed'))
      toast.error(t('saveFailed'))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function addRate() {
    // Keep compensation as decimal text all the way to the API. Converting a
    // valid numeric(19,4) value through Number can round it before the exact
    // boundary validator gets a chance to persist it.
    const amount = canonicalDecimal(rate, 4)
    if (amount === null || compareDecimal(amount, '0') < 0) {
      toast.error(t('rateRequired'))
      return
    }
    // Annual hours convert a time-based rate to its hourly cost; an hourly
    // rate keeps the column default.
    const timeBased = isTimePayRateBasis(basis)
    const hours = timeBased ? canonicalDecimal(annualHours, 4) : '2080'
    if (hours === null || (timeBased && compareDecimal(hours, '0') <= 0)) {
      toast.error(t('annualHoursRequired'))
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      toast.error(t('effectiveFromRequired'))
      return
    }
    // Omit payroll rounding terms so the native command inherits the policy
    // governing this effective date, including corrections and backdated rates.
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
      annualHours: hours,
      effectiveFrom,
    }, t('saved'))
    if (saved) {
      setRate('')
      setAdding(false)
    }
  }

  const formatDate = (value: string) => format.dateTime(new Date(`${value}T12:00:00Z`), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })

  const rateText = useCallback((row: RateRow) => `${row.rate} ${t(BASIS_LABEL_KEYS[row.basis])} ${row.effective_from} ${row.effective_to ?? ''}`, [t])
  const list = useSublistRows(data?.rates ?? [], rateText)
  const refusal = actionError ? (
    <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
      {t('saveFailed')}{actionError === t('saveFailed') ? null : `: ${actionError}`}
    </p>
  ) : null

  return (
    <DrawerSublist
      title={t('title')}
      description={(
        <span className="flex flex-wrap gap-3">
          <Link href="/admin/setup/labor-costing" className="flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
            <SlidersHorizontal size={13} aria-hidden /> {t('payrollPolicy')}
          </Link>
          <Link href="/docs/labor-costing" className="flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
            <BookOpen size={13} aria-hidden /> {t('documentation')}
          </Link>
        </span>
      )}
      action={<SublistAddButton label={t('add')} disabled={busy || data === null} onClick={() => { setActionError(null); setAdding(true) }} />}
      alert={adding ? null : refusal}
      search={data?.rates.length ? { value: list.query, onChange: list.setQuery, placeholder: t('search') } : undefined}
    >
      {loadError ? (
        <SublistLoadError message={tc('feedback.loadFailed')} onRetry={() => { setLoadError(false); void load() }} />
      ) : data === null ? (
        <SublistLoading />
      ) : (
        <PagedTable
          rows={list.filtered}
          rowKey={(row) => row.id}
          rowClassName={(row) => row.is_current ? 'bg-teal-50/80 dark:bg-teal-950/30' : undefined}
          pageSize={10}
          empty={<p className="py-6 text-center text-sm text-slate-400">{t('empty')}</p>}
          columns={[
            {
              key: 'rate',
              header: t('rate'),
              align: 'right',
              search: (row) => `${row.rate} ${t(BASIS_LABEL_KEYS[row.basis])}`,
              cell: (row) => {
                const equivalents = rateEquivalents(row)
                const amount = (value: string) => money(value, {
                  currency: row.currency,
                  currencyDisplay: 'code',
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })
                return (
                  <span className="inline-flex flex-col items-end">
                    <span className="inline-flex items-center gap-2 tabular-nums">
                      {money(row.rate, {
                        currency: row.currency,
                        currencyDisplay: 'code',
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 4,
                      })}
                      <span className="text-xs text-slate-500 dark:text-slate-400">{t(BASIS_LABEL_KEYS[row.basis])}</span>
                      {row.is_current ? <Badge variant="success">{t('current')}</Badge> : null}
                    </span>
                    {equivalents ? (
                      <span className="text-xs text-slate-500 tabular-nums dark:text-slate-400">
                        {t('equivalents', { hourly: amount(equivalents.hourly), annual: amount(equivalents.annual) })}
                      </span>
                    ) : null}
                  </span>
                )
              },
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
                      onClick={async () => {
                        if (!(await confirmDialog(t('confirmEnd')))) return
                        void mutate({ action: 'end-rate', id: row.id, effectiveTo: today }, t('ended'))
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
                    onClick={async () => {
                      if (!(await confirmDialog(t('confirmDelete')))) return
                      void mutate({ action: 'delete-rate', id: row.id }, t('deleted'))
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
      <Drawer
        open={adding}
        onClose={() => { if (!busy) setAdding(false) }}
        stacked
        size="md"
        title={t('add')}
        description={t('hint')}
        footer={(
          <>
            <Button variant="outline" disabled={busy} onClick={() => setAdding(false)}>{tc('actions.cancel')}</Button>
            <Button onClick={() => void addRate()} disabled={busy || data === null}>{busy ? tc('actions.saving') : tc('actions.save')}</Button>
          </>
        )}
      >
        <div className="space-y-4" inert={busy}>
          {refusal}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="employee-wage-rate" help={t('hint')}>{t('rate')}</Label>
            <Input
              id="employee-wage-rate"
              type="number"
              min="0"
              step="0.0001"
              value={rate}
              onChange={(event) => setRate(event.target.value)}
            />
          </div>
          {data && data.currencies.length > 1 ? (
            <div>
              <Label htmlFor="employee-wage-currency">{t('currency')}</Label>
              <Select
                id="employee-wage-currency"
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
              value={basis}
              onChange={(event) => {
                if (isPayRateBasis(event.target.value)) setBasis(event.target.value)
              }}
            >
              {PAY_RATE_BASES.map((value) => (
                <option key={value} value={value}>{t(BASIS_LABEL_KEYS[value])}</option>
              ))}
            </Select>
          </div>
          {isTimePayRateBasis(basis) ? (
            <div>
              <Label htmlFor="employee-wage-annual-hours">{t('annualHours')}</Label>
              <Input
                id="employee-wage-annual-hours"
                type="number"
                min="0.0001"
                step="0.01"
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
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </div>
        </div>
        </div>
      </Drawer>
    </DrawerSublist>
  )
}
