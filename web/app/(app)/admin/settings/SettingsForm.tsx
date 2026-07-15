'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type SelectOption,
} from '@openbooks/ui'
import { LOCALES, isLocale, type Locale } from '../../../../i18n/config'

export type AccountOption = { id: string; label: string; type: string }

type ControlAccounts = {
  ar: string
  ap: string
  bank: string
  taxCollected: string
  taxPaid: string
  employeePayable: string
}

type Initial = {
  name: string
  legalName: string
  country: string
  baseCurrency: string
  fiscalYearStartMonth: number
  defaultLocale: Locale
  reportPdfStyle: 'formal' | 'modern'
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
]

// Known document-number sequence kinds → admin.settings.documentKinds keys;
// unknown kinds fall back to the humanized enum code.
const DOCUMENT_KIND_KEYS: Record<string, string> = {
  vendor_bill: 'vendorBill',
  customer_invoice: 'customerInvoice',
  vendor_payment: 'vendorPayment',
  customer_payment: 'customerPayment',
  expense_report: 'expenseReport',
  journal: 'journal',
}

export function SettingsForm({
  initial,
  accounts,
  currencies,
  numberSequences,
}: {
  initial: Initial
  accounts: AccountOption[]
  currencies: { code: string; name: string }[]
  numberSequences: {
    document_kind: string
    prefix: string
    next_number: number
    padding: number
    gapless: boolean
  }[]
}) {
  const t = useTranslations('admin.settings')
  const tCommon = useTranslations('common')
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
            <Input
              id="country"
              value={form.country}
              onChange={(e) => setForm((f) => ({ ...f, country: e.target.value.toUpperCase() }))}
              placeholder={t('organization.countryPlaceholder')}
              maxLength={2}
              className="uppercase"
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('organization.countryHint')}
            </p>
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
                  value={form.controlAccounts[field.key]}
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

      {/* Document numbering (display) */}
      <Card>
        <CardHeader>
          <CardTitle>{t('numbering.title')}</CardTitle>
          <CardDescription>{t('numbering.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {numberSequences.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('numbering.empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('numbering.table.document')}</TableHead>
                  <TableHead>{t('numbering.table.prefix')}</TableHead>
                  <TableHead className="text-right">{t('numbering.table.next')}</TableHead>
                  <TableHead className="text-right">{t('numbering.table.padding')}</TableHead>
                  <TableHead>{t('numbering.table.example')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {numberSequences.map((s) => (
                  <TableRow key={s.document_kind}>
                    <TableCell className="font-medium capitalize">
                      {DOCUMENT_KIND_KEYS[s.document_kind]
                        ? t(`documentKinds.${DOCUMENT_KIND_KEYS[s.document_kind]}`)
                        : s.document_kind.replace(/_/g, ' ')}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{s.prefix || '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.next_number}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.padding}</TableCell>
                    <TableCell className="font-mono text-xs text-slate-500 dark:text-slate-400">
                      {s.prefix}
                      {String(s.next_number).padStart(s.padding, '0')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
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
