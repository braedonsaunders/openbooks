'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { CheckCircle2, CircleAlert, Clock3, KeyRound, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, Select } from '@openbooks/ui'

type Provider = 'bank_of_canada' | 'ecb' | 'open_exchange_rates'
type Schedule = 'manual' | 'daily' | 'weekdays' | 'weekly'
type Config = {
  provider: Provider
  displayName: string
  baseCurrency: string
  currencies: string[]
  schedule: Schedule
  syncHourUtc: number
  lookbackDays: number
  isEnabled: boolean
  hasSecret: boolean
  nextSyncAt: string | null
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastObservationDate: string | null
  lastError: string | null
}
type Run = {
  id: string
  trigger: string
  status: string
  observationsReceived: number
  ratesInserted: number
  ratesUpdated: number
  manualOverridesPreserved: number
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
}

export function FxProviderForm({
  initial,
  currencies,
  recommendedCurrencies,
  lastRun,
}: {
  initial: Config | null
  currencies: { code: string; name: string }[]
  recommendedCurrencies: string[]
  lastRun: Run | null
}) {
  const t = useTranslations('admin.setup.fxProvider')
  const tc = useTranslations('common')
  const locale = useLocale()
  const router = useRouter()
  const fallbackBase = recommendedCurrencies[0] ?? 'CAD'
  const [form, setForm] = useState(() => ({
    provider: initial?.provider ?? (fallbackBase === 'CAD' ? 'bank_of_canada' : fallbackBase === 'EUR' ? 'ecb' : 'open_exchange_rates') as Provider,
    displayName: initial?.displayName ?? '',
    baseCurrency: initial?.baseCurrency ?? fallbackBase,
    currencies: initial?.currencies ?? recommendedCurrencies.filter((code) => code !== fallbackBase),
    schedule: initial?.schedule ?? 'daily' as Schedule,
    syncHourUtc: initial?.syncHourUtc ?? 22,
    lookbackDays: initial?.lookbackDays ?? 7,
    isEnabled: initial?.isEnabled ?? false,
  }))
  const [apiKey, setApiKey] = useState('')
  const [clearSecret, setClearSecret] = useState(false)
  const [currencyToAdd, setCurrencyToAdd] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | 'sync' | null>(null)

  const currencyOptions = useMemo(
    () => currencies
      .filter((currency) => currency.code !== form.baseCurrency && !form.currencies.includes(currency.code))
      .map((currency) => ({ value: currency.code, label: `${currency.code} · ${currency.name}` })),
    [currencies, form.baseCurrency, form.currencies],
  )
  const baseOptions = currencies.map((currency) => ({ value: currency.code, label: `${currency.code} · ${currency.name}` }))
  const formatDateTime = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))

  async function persist(): Promise<boolean> {
    const res = await fetch('/api/admin/fx-provider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        apiKey: clearSecret ? null : apiKey.trim() || undefined,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(data.error ?? tc('feedback.saveFailed'))
      return false
    }
    setApiKey('')
    setClearSecret(false)
    return true
  }

  async function save() {
    setBusy('save')
    if (await persist()) {
      toast.success(t('saved'))
      router.refresh()
    }
    setBusy(null)
  }

  async function action(kind: 'test' | 'sync') {
    setBusy(kind)
    if (!(await persist())) { setBusy(null); return }
    const res = await fetch('/api/admin/fx-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: kind }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) toast.error(data.error ?? t(`${kind}Failed`))
    else {
      toast.success(t(kind === 'test' ? 'testPassed' : 'syncPassed', {
        observations: data.result?.observationsReceived ?? 0,
        rates: data.result?.normalizedRates ?? 0,
      }))
      router.refresh()
    }
    setBusy(null)
  }

  function addCurrency(value: string | null) {
    if (!value) return
    setForm((current) => ({ ...current, currencies: [...new Set([...current.currencies, value])].sort() }))
    setCurrencyToAdd('')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('description')}</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t('provider')}</Label>
            <Select
              value={form.provider}
              onChange={(event) => setForm((current) => ({ ...current, provider: event.target.value as Provider }))}
            >
              <option value="bank_of_canada">{t('providers.bank_of_canada')}</option>
              <option value="ecb">{t('providers.ecb')}</option>
              <option value="open_exchange_rates">{t('providers.open_exchange_rates')}</option>
            </Select>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t(`providerHelp.${form.provider}`)}</p>
          </div>
          <div className="space-y-1.5">
            <Label>{t('displayName')}</Label>
            <Input value={form.displayName} onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} placeholder={t('displayNamePlaceholder')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('baseCurrency')}</Label>
            <SearchSelect options={baseOptions} value={form.baseCurrency} onChange={(value) => setForm((current) => ({ ...current, baseCurrency: value ?? current.baseCurrency, currencies: current.currencies.filter((code) => code !== value) }))} placeholder={t('selectCurrency')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('schedule')}</Label>
            <Select value={form.schedule} onChange={(event) => setForm((current) => ({ ...current, schedule: event.target.value as Schedule }))}>
              <option value="manual">{t('schedules.manual')}</option>
              <option value="daily">{t('schedules.daily')}</option>
              <option value="weekdays">{t('schedules.weekdays')}</option>
              <option value="weekly">{t('schedules.weekly')}</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('syncHourUtc')}</Label>
            <Input type="number" min={0} max={23} value={form.syncHourUtc} onChange={(event) => setForm((current) => ({ ...current, syncHourUtc: Number(event.target.value) }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('lookbackDays')}</Label>
            <Input type="number" min={1} max={31} value={form.lookbackDays} onChange={(event) => setForm((current) => ({ ...current, lookbackDays: Number(event.target.value) }))} />
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <Label>{t('currencies')}</Label>
          <SearchSelect options={currencyOptions} value={currencyToAdd} onChange={addCurrency} placeholder={t('addCurrency')} searchPlaceholder={t('searchCurrencies')} />
          <div className="flex flex-wrap gap-2">
            {form.currencies.map((currency) => (
              <span key={currency} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                {currency}
                <button type="button" onClick={() => setForm((current) => ({ ...current, currencies: current.currencies.filter((code) => code !== currency) }))} aria-label={t('removeCurrency', { currency })}>
                  <X size={12} />
                </button>
              </span>
            ))}
            {form.currencies.length === 0 ? <span className="text-xs text-slate-500">{t('noCurrencies')}</span> : null}
          </div>
        </div>

        {form.provider === 'open_exchange_rates' ? (
          <div className="mt-4 space-y-1.5">
            <Label>{t('apiKey')}</Label>
            <div className="flex items-center gap-2">
              <KeyRound size={16} className="text-slate-400" />
              <Input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearSecret(false) }} placeholder={initial?.hasSecret ? t('secretStored') : t('apiKeyPlaceholder')} />
            </div>
            {initial?.hasSecret ? (
              <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <input type="checkbox" checked={clearSecret} onChange={(event) => setClearSecret(event.target.checked)} />
                {t('clearSecret')}
              </label>
            ) : null}
          </div>
        ) : null}

        <label className="mt-4 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input type="checkbox" checked={form.isEnabled} onChange={(event) => setForm((current) => ({ ...current, isEnabled: event.target.checked }))} />
          {t('enabled')}
        </label>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button onClick={save} disabled={busy !== null}>{busy === 'save' ? tc('actions.saving') : tc('actions.save')}</Button>
          <Button variant="outline" onClick={() => action('test')} disabled={busy !== null}><CheckCircle2 size={15} /> {t('test')}</Button>
          <Button variant="outline" onClick={() => action('sync')} disabled={busy !== null || !form.isEnabled}><RefreshCw size={15} className={busy === 'sync' ? 'animate-spin' : ''} /> {t('syncNow')}</Button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h3 className="font-medium text-slate-900 dark:text-slate-100">{t('health')}</h3>
        <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div><span className="text-slate-500">{t('lastSuccess')}</span><p>{initial?.lastSuccessAt ? formatDateTime(initial.lastSuccessAt) : '—'}</p></div>
          <div><span className="text-slate-500">{t('lastObservation')}</span><p>{initial?.lastObservationDate ?? '—'}</p></div>
          <div><span className="text-slate-500">{t('nextSync')}</span><p>{initial?.nextSyncAt ? formatDateTime(initial.nextSyncAt) : '—'}</p></div>
        </div>
        {initial?.lastError ? <div className="mt-3 flex gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"><CircleAlert size={16} className="mt-0.5 shrink-0" />{initial.lastError}</div> : null}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h3 className="font-medium text-slate-900 dark:text-slate-100">{t('latestRun')}</h3>
        <div className="mt-3">
          {!lastRun ? <p className="text-sm text-slate-500">{t('noRuns')}</p> : (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 px-3 py-2 text-xs dark:border-slate-800">
              <Clock3 size={14} className="text-slate-400" />
              <span>{formatDateTime(lastRun.startedAt)}</span>
              <Badge variant={lastRun.status === 'ok' ? 'success' : lastRun.status === 'failed' ? 'destructive' : 'secondary'}>{t(`runStatus.${lastRun.status}`)}</Badge>
              <span className="text-slate-500">{t('runSummary', { observations: lastRun.observationsReceived, inserted: lastRun.ratesInserted, updated: lastRun.ratesUpdated, preserved: lastRun.manualOverridesPreserved })}</span>
              {lastRun.errorMessage ? <span className="text-red-600 dark:text-red-400">{lastRun.errorMessage}</span> : null}
            </div>
          )}
        </div>
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">{t('overridePolicy')}</p>
    </div>
  )
}
