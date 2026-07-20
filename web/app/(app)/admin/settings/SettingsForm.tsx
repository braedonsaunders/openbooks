'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { CalendarClock } from 'lucide-react'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  SearchSelect,
  Select,
  type SelectOption,
} from '@openbooks/ui'
import { LOCALES, isLocale, type Locale } from '../../../../i18n/config'
import { countryOptions } from '../../../../lib/countries'

export type AccountOption = { id: string; label: string; type: string }

type ControlAccounts = {
  ar: string
  ap: string
  bank: string
  taxCollected: string
  taxPaid: string
  employeePayable: string
  fxUnrealizedGainLoss: string
  laborWip?: string
  laborClearing?: string
  unbilledReceivable?: string
  projectRevenue?: string
}

type Initial = {
  name: string
  legalName: string
  country: string
  baseCurrency: string
  fiscalYearStartMonth: number
  defaultLocale: Locale
  reportPdfStyle: 'formal' | 'modern'
  fairValueRangePolicy: 'warn' | 'off'
  controlAccounts: ControlAccounts
}

// Month message keys under admin.settings.months, indexed 0–11.
const MONTH_KEYS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const

// Control-account fields; label/hint are message keys under
// admin.settings.controlAccounts.fields, translated at the render site.
const CONTROL_FIELDS: { key: keyof ControlAccounts }[] = [
  { key: 'ar' },
  { key: 'ap' },
  { key: 'bank' },
  { key: 'taxCollected' },
  { key: 'taxPaid' },
  { key: 'employeePayable' },
  { key: 'fxUnrealizedGainLoss' },
  { key: 'laborWip' },
  { key: 'laborClearing' },
  { key: 'unbilledReceivable' },
  { key: 'projectRevenue' },
]

export function SettingsForm({
  initial,
  accounts,
  currencies,
}: {
  initial: Initial
  accounts: AccountOption[]
  currencies: { code: string; name: string }[]
}) {
  const t = useTranslations('admin.settings')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const countries = useMemo(() => countryOptions(locale), [locale])
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(initial)

  const monthLabel = (m: number) => t(`months.${MONTH_KEYS[(m - 1 + 12) % 12]}`)
  /** "January → December" label for a fiscal year starting in `startMonth`. */
  const fiscalRangeLabel = (startMonth: number) =>
    t('fiscal.range', { start: monthLabel(startMonth), end: monthLabel(((startMonth + 10) % 12) + 1) })

  const accountOptions: SelectOption[] = useMemo(
    () => accounts.map((a) => ({ value: a.id, label: a.label })),
    [accounts],
  )

  const startMonthChanged = form.fiscalYearStartMonth !== initial.fiscalYearStartMonth

  function setControl(key: keyof ControlAccounts, value: string) {
    setForm((f) => ({ ...f, controlAccounts: { ...f.controlAccounts, [key]: value } }))
  }

  async function save() {
    if (!form.name.trim()) {
      toast.error(t('validation.nameRequired'))
      return
    }
    if (!form.country.trim()) {
      toast.error(t('validation.countryRequired'))
      return
    }
    setSaving(true)
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    setSaving(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error ?? tCommon('feedback.saveFailed'))
      return
    }
    const data = (await res.json()) as { changed?: boolean; periodsRederived?: boolean }
    if (data.changed === false) {
      toast(tCommon('feedback.noChanges'))
      return
    }
    toast.success(data.periodsRederived ? t('savedPeriodsRederived') : t('saved'))
    router.refresh()
  }

  return (
    <div className="space-y-6">
      {/* Organization identity */}
      <Card>
        <CardHeader>
          <CardTitle>{t('organization.title')}</CardTitle>
          <CardDescription>{t('organization.description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="name">{t('organization.displayName')}</Label>
            <Input
              id="name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={t('organization.displayNamePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="legalName">{t('organization.legalName')}</Label>
            <Input
              id="legalName"
              value={form.legalName}
              onChange={(e) => setForm((f) => ({ ...f, legalName: e.target.value }))}
              placeholder={t('organization.legalNamePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="country">{t('organization.country')}</Label>
            <SearchSelect
              ariaLabel={t('organization.country')}
              value={form.country}
              onChange={(value) => setForm((f) => ({ ...f, country: (value ?? '').toUpperCase() }))}
              options={countries}
              placeholder={t('organization.countryPlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="defaultLocale">{t('organization.defaultLanguage')}</Label>
            <Select
              id="defaultLocale"
              value={form.defaultLocale}
              onChange={(e) =>
                setForm((f) =>
                  isLocale(e.target.value) ? { ...f, defaultLocale: e.target.value } : f,
                )
              }
            >
              {LOCALES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('organization.defaultLanguageHint')}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reportPdfStyle">{t('organization.reportPdfStyle')}</Label>
            <Select
              id="reportPdfStyle"
              value={form.reportPdfStyle}
              onChange={(e) =>
                setForm((f) => ({ ...f, reportPdfStyle: e.target.value === 'formal' ? 'formal' : 'modern' }))
              }
            >
              <option value="modern">{t('organization.reportPdfStyleModern')}</option>
              <option value="formal">{t('organization.reportPdfStyleFormal')}</option>
            </Select>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('organization.reportPdfStyleHint')}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="baseCurrency">{t('organization.baseCurrency')}</Label>
            <Select
              id="baseCurrency"
              value={form.baseCurrency}
              onChange={(e) => setForm((f) => ({ ...f, baseCurrency: e.target.value }))}
            >
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </Select>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('organization.baseCurrencyHint')}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Fiscal year — the headline setting */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock size={17} className="text-teal-600 dark:text-teal-300" />
            {t('fiscal.title')}
          </CardTitle>
          <CardDescription>{t('fiscal.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="fiscalStart">{t('fiscal.startsIn')}</Label>
              <Select
                id="fiscalStart"
                value={String(form.fiscalYearStartMonth)}
                onChange={(e) =>
                  setForm((f) => ({ ...f, fiscalYearStartMonth: Number(e.target.value) }))
                }
              >
                {MONTH_KEYS.map((m, i) => (
                  <option key={m} value={String(i + 1)}>
                    {t(`months.${m}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('fiscal.runs')}</Label>
              <div className="flex h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
                {fiscalRangeLabel(form.fiscalYearStartMonth)}
              </div>
            </div>
          </div>
          {startMonthChanged ? (
            <Alert variant="warning">
              <AlertDescription>
                {t.rich('fiscal.warning', {
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {/* Revenue recognition */}
      <Card>
        <CardHeader>
          <CardTitle>{t('revenue.title')}</CardTitle>
          <CardDescription>
            {t('revenue.description')}{' '}
            <Link href="/docs/revenue-recognition" className="font-medium text-teal-700 hover:underline dark:text-teal-300">
              {t('revenue.learnMore')}
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="fairValueRangePolicy">{t('revenue.fairValueRangePolicy.label')}</Label>
            <Select
              id="fairValueRangePolicy"
              value={form.fairValueRangePolicy}
              onChange={(e) =>
                setForm((f) => ({ ...f, fairValueRangePolicy: e.target.value === 'off' ? 'off' : 'warn' }))
              }
            >
              <option value="warn">{t('revenue.fairValueRangePolicy.warn')}</option>
              <option value="off">{t('revenue.fairValueRangePolicy.off')}</option>
            </Select>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('revenue.fairValueRangePolicy.hint')}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Control accounts */}
      <Card>
        <CardHeader>
          <CardTitle>{t('controlAccounts.title')}</CardTitle>
          <CardDescription>{t('controlAccounts.description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {CONTROL_FIELDS.map((field) => {
            const label = t(`controlAccounts.fields.${field.key}.label`)
            return (
              <div key={field.key} className="space-y-1.5">
                <Label htmlFor={`ctrl-${field.key}`}>{label}</Label>
                <SearchSelect
                  id={`ctrl-${field.key}`}
                  value={form.controlAccounts[field.key] ?? ''}
                  onChange={(v) => setControl(field.key, v)}
                  options={accountOptions}
                  placeholder={t('controlAccounts.selectPlaceholder')}
                  searchPlaceholder={t('controlAccounts.searchPlaceholder')}
                  sheetTitle={label}
                  clearable
                  emptyLabel={tCommon('labels.notSet')}
                  ariaLabel={label}
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t(`controlAccounts.fields.${field.key}.hint`)}
                </p>
              </div>
            )
          })}
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        <Button variant="outline" disabled={saving} onClick={() => setForm(initial)}>
          {tCommon('actions.reset')}
        </Button>
        <Button disabled={saving} onClick={save}>
          {saving ? tCommon('actions.saving') : t('saveSettings')}
        </Button>
      </div>
    </div>
  )
}
