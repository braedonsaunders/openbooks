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
  FieldLabel,
  Input,
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
  fxRealizedGainLoss: string
  retainagePayable?: string
  laborWip?: string
  laborClearing?: string
  unbilledReceivable?: string
  projectRevenue?: string
  incomeTaxExpense?: string
  incomeTaxPayable?: string
  deferredTaxAsset?: string
  deferredTaxLiability?: string
  valuationAllowance?: string
}

type Initial = {
  name: string
  legalName: string
  country: string
  baseCurrency: string
  fiscalYearStartMonth: number
  taxFramework?: 'asc740' | 'ias12'
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
  { key: 'fxRealizedGainLoss' },
  { key: 'retainagePayable' },
  { key: 'laborWip' },
  { key: 'laborClearing' },
  { key: 'unbilledReceivable' },
  { key: 'projectRevenue' },
  { key: 'incomeTaxExpense' },
  { key: 'incomeTaxPayable' },
  { key: 'deferredTaxAsset' },
  { key: 'deferredTaxLiability' },
  { key: 'valuationAllowance' },
]

export function SettingsForm({
  initial,
  accounts,
  currencies,
  multiSubsidiary = false,
}: {
  initial: Initial
  accounts: AccountOption[]
  currencies: { code: string; name: string }[]
  /** When the org runs multiple legal entities, identity/currency are per
   *  subsidiary and control accounts here are the fallback defaults. */
  multiSubsidiary?: boolean
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
        {multiSubsidiary ? (
          <CardContent className="pt-0">
            <Alert>
              <AlertDescription className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <span>{t('organization.perEntityNote')}</span>
                <Link href="/admin/setup/subsidiaries" className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                  {t('organization.subsidiariesLink')}
                </Link>
              </AlertDescription>
            </Alert>
          </CardContent>
        ) : null}
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <FieldLabel htmlFor="name" help={t('organization.displayNameHint')}>{t('organization.displayName')}</FieldLabel>
            <Input
              id="name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={t('organization.displayNamePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="legalName" help={t('organization.legalNameHint')}>{t('organization.legalName')}</FieldLabel>
            <Input
              id="legalName"
              value={form.legalName}
              onChange={(e) => setForm((f) => ({ ...f, legalName: e.target.value }))}
              placeholder={t('organization.legalNamePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="country" help={t('organization.countryHint')}>{t('organization.country')}</FieldLabel>
            <SearchSelect
              ariaLabel={t('organization.country')}
              value={form.country}
              onChange={(value) => setForm((f) => ({ ...f, country: (value ?? '').toUpperCase() }))}
              options={countries}
              placeholder={t('organization.countryPlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="defaultLocale" help={t('organization.defaultLanguageHint')}>{t('organization.defaultLanguage')}</FieldLabel>
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
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="reportPdfStyle" help={t('organization.reportPdfStyleHint')}>{t('organization.reportPdfStyle')}</FieldLabel>
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
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="baseCurrency" help={t('organization.baseCurrencyHint')}>{t('organization.baseCurrency')}</FieldLabel>
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
              <FieldLabel htmlFor="fiscalStart" help={t('fiscal.description')}>{t('fiscal.startsIn')}</FieldLabel>
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
              <FieldLabel help={t('fiscal.description')}>{t('fiscal.runs')}</FieldLabel>
              <div className="flex h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
                {fiscalRangeLabel(form.fiscalYearStartMonth)}
              </div>
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="taxFramework" help={t('fiscal.taxFrameworkHint')}>{t('fiscal.taxFramework')}</FieldLabel>
              <Select
                id="taxFramework"
                value={form.taxFramework ?? 'asc740'}
                onChange={(e) => setForm((f) => ({ ...f, taxFramework: e.target.value as 'asc740' | 'ias12' }))}
              >
                <option value="asc740">{t('fiscal.frameworkAsc740')}</option>
                <option value="ias12">{t('fiscal.frameworkIas12')}</option>
              </Select>
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
            <FieldLabel htmlFor="fairValueRangePolicy" help={t('revenue.fairValueRangePolicy.hint')}>{t('revenue.fairValueRangePolicy.label')}</FieldLabel>
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
          </div>
        </CardContent>
      </Card>

      {/* Control accounts */}
      <Card>
        <CardHeader>
          <CardTitle>{t('controlAccounts.title')}</CardTitle>
          <CardDescription>{t('controlAccounts.description')}</CardDescription>
        </CardHeader>
        {multiSubsidiary ? (
          <CardContent className="pt-0">
            <Alert>
              <AlertDescription>{t('controlAccounts.defaultsNote')}</AlertDescription>
            </Alert>
          </CardContent>
        ) : null}
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {CONTROL_FIELDS.map((field) => {
            const label = t(`controlAccounts.fields.${field.key}.label`)
            return (
              <div key={field.key} className="space-y-1.5">
                <FieldLabel htmlFor={`ctrl-${field.key}`} help={t(`controlAccounts.fields.${field.key}.hint`)}>{label}</FieldLabel>
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
