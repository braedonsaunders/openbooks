'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import {
  Badge,
  Button,
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
  Textarea,
  UrlDrawer,
  cn,
} from '@openbooks/ui'
import { SearchInput } from '../../../../../components/search-input'
import { FilterChips } from '../../../../../components/filter-bar'
import { Pagination } from '../../../../../components/pagination'
import { countryOptions } from '../../../../../lib/countries'

export type PaymentSetupView = 'profiles' | 'formats' | 'schedules' | 'mandates'

type Options = {
  formats: Array<{ id: string; name: string; rail: string; currency: string | null }>
  bankAccounts: Array<{ id: string; number: string | null; name: string }>
  accountingAccounts: Array<{ id: string; number: string | null; name: string }>
  subsidiaries: Array<{ id: string; name: string }>
  sftpServers: Array<{ id: string; name: string }>
  profiles: Array<{ id: string; name: string }>
  parties: Array<{ id: string; display_name: string; bank_accounts: Array<{ id: string; label: string }> }>
  currencies: Array<{ code: string; name: string }>
}

/** Currency picker over the org's currency reference table (never free text). */
function CurrencyField({ value, onChange, label, currencies, allowInherit }: { value: string; onChange: (v: string) => void; label: string; currencies: Array<{ code: string; name: string }>; allowInherit?: boolean }) {
  return (
    <Field label={label}>
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {allowInherit && <option value="">Inherit from format / account</option>}
        {!allowInherit && !value && <option value="">Select…</option>}
        {currencies.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
      </Select>
    </Field>
  )
}

const VIEWS: PaymentSetupView[] = ['profiles', 'formats', 'schedules', 'mandates']

const SECRET_FIELDS: Record<string, string[]> = {
  cpa005_credit: ['originatorId', 'originatorShortName', 'originatorLongName', 'dataCentre', 'originatingDataCentre', 'institution', 'transit', 'account', 'transactionCode'],
  nacha_credit: ['odfiRouting', 'immediateDestination', 'immediateOrigin', 'destinationName', 'originName', 'companyName', 'companyId', 'entryClassCode', 'entryDescription'],
  nacha_debit: ['odfiRouting', 'immediateDestination', 'immediateOrigin', 'destinationName', 'originName', 'companyName', 'companyId', 'entryClassCode', 'entryDescription'],
  sepa_credit: ['originatorName', 'originatorIban', 'originatorBic'],
  sepa_debit: ['originatorName', 'originatorIban', 'originatorBic', 'creditorId'],
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-teal-600" />
      {label}
    </label>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>
}

function CountryField({ value, onChange, label, placeholder }: { value: string; onChange: (value: string) => void; label: string; placeholder: string }) {
  const locale = useLocale()
  const options = useMemo(() => countryOptions(locale), [locale])
  return (
    <Field label={label}>
      <SearchSelect
        value={value}
        onChange={onChange}
        options={options}
        placeholder={placeholder}
        sheetTitle={label}
        clearable
        ariaLabel={label}
      />
    </Field>
  )
}

export function PaymentOperationsSetup({
  view,
  rows,
  selected,
  creating,
  total,
  page,
  perPage,
  currentParams,
  stateCounts,
  options,
  multiCurrency = false,
}: {
  view: PaymentSetupView
  rows: Record<string, any>[]
  selected: Record<string, any> | null
  creating: boolean
  total: number
  page: number
  perPage: number
  currentParams: Record<string, string | string[] | undefined>
  stateCounts: Array<{ value: string; count: number }>
  options: Options
  multiCurrency?: boolean
}) {
  const t = useTranslations('admin.setup.paymentOperations')
  const basePath = '/admin/setup/payment-operations'
  const closeHref = `${basePath}?view=${view}`
  const stateOptions = stateCounts.map((s) => ({ value: s.value, label: t(`states.${s.value}` as any), count: Number(s.count) }))
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('description')}</p>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {VIEWS.map((item) => (
          <Link
            key={item}
            href={`${basePath}?view=${item}`}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              view === item ? 'border-teal-600 text-teal-700 dark:text-teal-300' : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-100',
            )}
          >
            {t(`tabs.${item}`)}
          </Link>
        ))}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput placeholder={t(`search.${view}`)} />
          <FilterChips
            basePath={basePath}
            currentParams={currentParams}
            paramKey="state"
            pageParamKey="page"
            label={t('state')}
            options={stateOptions}
          />
        </div>
        <Button asChild>
          <Link href={`${basePath}?view=${view}&row=new`}><Plus size={15} />{t(`new.${view}`)}</Link>
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <SetupTable view={view} rows={rows} t={t} basePath={basePath} />
      </div>
      <Pagination basePath={basePath} currentParams={currentParams} total={total} page={page} perPage={perPage} />

      {(creating || selected) ? (
        <SetupEditor view={view} row={selected} creating={creating} options={options} closeHref={closeHref} multiCurrency={multiCurrency} />
      ) : null}
    </div>
  )
}

function SetupTable({ view, rows, t, basePath }: { view: PaymentSetupView; rows: Record<string, any>[]; t: any; basePath: string }) {
  const cols: Record<PaymentSetupView, string[]> = {
    profiles: ['name', 'bank', 'format', 'currency', 'delivery', 'approval', 'status'],
    formats: ['code', 'name', 'rail', 'direction', 'currency', 'status'],
    schedules: ['name', 'profile', 'cron', 'nextRun', 'action', 'status'],
    mandates: ['reference', 'party', 'scheme', 'signedOn', 'expiresOn', 'status'],
  }
  return (
    <Table>
      <TableHeader><TableRow>{cols[view].map((c) => <TableHead key={c}>{t(`columns.${c}`)}</TableHead>)}</TableRow></TableHeader>
      <TableBody>
        {rows.length === 0 ? <TableRow><TableCell colSpan={cols[view].length} className="py-10 text-center text-slate-500">{t('empty')}</TableCell></TableRow> : rows.map((row) => {
          const href = `${basePath}?view=${view}&row=${row.id}`
          if (view === 'profiles') return <TableRow key={row.id}>
            <TableCell><Link href={href} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{row.name}</Link></TableCell>
            <TableCell>{[row.bank_number, row.bank_name].filter(Boolean).join(' · ')}</TableCell><TableCell>{row.format_name}</TableCell>
            <TableCell className="font-mono text-xs">{row.currency}</TableCell><TableCell>{row.sftp_server_name ?? t('manualDelivery')}</TableCell>
            <TableCell>{row.require_run_approval ? t('runApproval') : t('automatic')}</TableCell><TableCell><Active active={row.is_active} t={t} /></TableCell>
          </TableRow>
          if (view === 'formats') return <TableRow key={row.id}>
            <TableCell><Link href={href} className="font-mono text-xs font-semibold text-teal-700 hover:underline dark:text-teal-300">{row.code}</Link></TableCell>
            <TableCell>{row.name}</TableCell><TableCell><Badge variant="outline">{t(`rails.${row.rail}`)}</Badge></TableCell>
            <TableCell>{t(`directions.${row.direction}`)}</TableCell><TableCell className="font-mono text-xs">{row.currency ?? t('any')}</TableCell><TableCell><Active active={row.is_active} t={t} /></TableCell>
          </TableRow>
          if (view === 'schedules') return <TableRow key={row.id}>
            <TableCell><Link href={href} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{row.name}</Link></TableCell><TableCell>{row.profile_name}</TableCell>
            <TableCell className="font-mono text-xs">{row.cron}</TableCell><TableCell>{row.next_run_at ? new Date(row.next_run_at).toLocaleString() : '—'}</TableCell>
            <TableCell>{t(`actions.${row.action}`)}</TableCell><TableCell><Active active={row.is_active} t={t} /></TableCell>
          </TableRow>
          return <TableRow key={row.id}>
            <TableCell><Link href={href} className="font-mono text-xs font-semibold text-teal-700 hover:underline dark:text-teal-300">{row.mandate_reference}</Link></TableCell>
            <TableCell>{row.party_name}</TableCell><TableCell>{t(`schemes.${row.scheme}`)}</TableCell><TableCell>{row.signed_on ?? '—'}</TableCell><TableCell>{row.expires_on ?? '—'}</TableCell>
            <TableCell><Badge variant={row.status === 'active' ? 'success' : row.status === 'revoked' ? 'destructive' : 'secondary'}>{t(`states.${row.status}`)}</Badge></TableCell>
          </TableRow>
        })}
      </TableBody>
    </Table>
  )
}

function Active({ active, t }: { active: boolean; t: any }) {
  return <Badge variant={active ? 'success' : 'outline'}>{t(`states.${active ? 'active' : 'archived'}`)}</Badge>
}

function SetupEditor({ view, row, creating, options, closeHref, multiCurrency = false }: { view: PaymentSetupView; row: Record<string, any> | null; creating: boolean; options: Options; closeHref: string; multiCurrency?: boolean }) {
  const t = useTranslations('admin.setup.paymentOperations')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const initial = useMemo(() => row ?? {}, [row])
  const [form, setForm] = useState<Record<string, any>>(() => ({ ...initial }))
  const set = (key: string, value: unknown) => setForm((prev) => ({ ...prev, [key]: value }))
  const title = creating ? t(`drawer.new.${view}`) : t(`drawer.edit.${view}`)

  async function save() {
    setBusy(true)
    try {
      const resource = view
      const payload = normalizePayload(view, form, creating, multiCurrency)
      const res = await fetch(`/api/admin/payment-operations/${resource}${creating ? '' : `/${row!.id}`}`, {
        method: creating ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(data.error ?? t('saveFailed')); return }
      toast.success(t('saved'))
      router.push(closeHref as any)
      router.refresh()
    } finally { setBusy(false) }
  }

  return (
    <UrlDrawer open closeHref={closeHref} size="lg" title={title} description={t(`drawer.description.${view}`)} footer={
      <div className="flex w-full justify-end gap-2"><Button variant="outline" onClick={() => router.push(closeHref as any)}>{t('cancel')}</Button><Button disabled={busy} onClick={save}>{busy ? t('saving') : t('save')}</Button></div>
    }>
      <div className="space-y-5 p-1">
        {view === 'profiles' ? <ProfileFields form={form} set={set} options={options} t={t} creating={creating} multiCurrency={multiCurrency} /> : null}
        {view === 'formats' ? <FormatFields form={form} set={set} options={options} t={t} creating={creating} multiCurrency={multiCurrency} /> : null}
        {view === 'schedules' ? <ScheduleFields form={form} set={set} options={options} t={t} /> : null}
        {view === 'mandates' ? <MandateFields form={form} set={set} options={options} t={t} creating={creating} /> : null}
      </div>
    </UrlDrawer>
  )
}

function normalizePayload(view: PaymentSetupView, form: Record<string, any>, creating: boolean, multiCurrency = false) {
  if (view === 'profiles') {
    const originatorSecrets = Object.fromEntries(Object.entries(form.originatorSecrets ?? {}).filter(([, value]) => String(value ?? '').trim()))
    return {
      name: form.name, bankAccountId: form.bank_account_id ?? form.bankAccountId,
      subsidiaryId: form.subsidiary_id ?? form.subsidiaryId ?? null,
      paymentFormatId: form.payment_format_id ?? form.paymentFormatId, ...(multiCurrency ? { currency: String(form.currency ?? '').toUpperCase() } : {}),
      country: form.country || null, ...(Object.keys(originatorSecrets).length ? { originatorSecrets } : {}),
      settings: form.settings ?? {}, sftpServerId: form.sftp_server_id ?? form.sftpServerId ?? null,
      sftpFolder: form.sftp_folder ?? form.sftpFolder ?? null,
      requireRunApproval: form.require_run_approval ?? form.requireRunApproval ?? true,
      requireFileApproval: form.require_file_approval ?? form.requireFileApproval ?? false,
      autoRemittance: form.auto_remittance ?? form.autoRemittance ?? false,
      isActive: form.is_active ?? form.isActive ?? true,
    }
  }
  if (view === 'formats') return { code: form.code, name: form.name, direction: form.direction, country: form.country, ...(multiCurrency ? { currency: form.currency } : {}), fileExtension: form.file_extension ?? form.fileExtension, contentType: form.content_type ?? form.contentType, formatterScript: form.formatter_script ?? form.formatterScript, isActive: form.is_active ?? form.isActive ?? true }
  if (view === 'schedules') return { name: form.name, paymentBankProfileId: form.payment_bank_profile_id ?? form.paymentBankProfileId, cron: form.cron, timezone: form.timezone, action: form.action, selectionCriteria: form.selection_criteria ?? form.selectionCriteria ?? {}, isActive: form.is_active ?? form.isActive ?? true }
  return { partyId: form.party_id ?? form.partyId, partyBankAccountId: form.party_bank_account_id ?? form.partyBankAccountId, scheme: form.scheme, mandateReference: form.mandate_reference ?? form.mandateReference, status: form.status, signedOn: form.signed_on ?? form.signedOn, validFrom: form.valid_from ?? form.validFrom, expiresOn: form.expires_on ?? form.expiresOn, ...(creating ? {} : { id: form.id }) }
}

function ProfileFields({ form, set, options, t, creating, multiCurrency = false }: { form: Record<string, any>; set: (k: string, v: any) => void; options: Options; t: any; creating: boolean; multiCurrency?: boolean }) {
  const formatId = form.payment_format_id ?? form.paymentFormatId ?? ''
  const format = options.formats.find((f) => f.id === formatId)
  const secretFields = SECRET_FIELDS[format?.rail ?? ''] ?? []
  const secrets = form.originatorSecrets ?? {}
  const settings = form.settings ?? {}
  const secretSet = (key: string, value: string) => set('originatorSecrets', { ...secrets, [key]: value })
  const settingSet = (key: string, value: unknown) => set('settings', { ...settings, [key]: value })
  return <>
    <div className="grid gap-4 sm:grid-cols-2"><Field label={t('fields.name')}><Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
      {multiCurrency ? <CurrencyField label={t('fields.currency')} currencies={options.currencies} value={form.currency ?? format?.currency ?? ''} onChange={(v) => set('currency', v)} /> : null}</div>
    <Field label={t('fields.bankAccount')}><Select value={form.bank_account_id ?? form.bankAccountId ?? ''} onChange={(e) => set('bankAccountId', e.target.value)}><option value="">{t('select')}</option>{options.bankAccounts.map((a) => <option key={a.id} value={a.id}>{[a.number, a.name].filter(Boolean).join(' · ')}</option>)}</Select></Field>
    <Field label={t('fields.format')}><Select value={formatId} onChange={(e) => set('paymentFormatId', e.target.value)}><option value="">{t('select')}</option>{options.formats.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select></Field>
    <div className="grid gap-4 sm:grid-cols-2">{options.subsidiaries.length > 0 ? <Field label={t('fields.subsidiary')}><Select value={form.subsidiary_id ?? form.subsidiaryId ?? ''} onChange={(e) => set('subsidiaryId', e.target.value || null)}><option value="">{t('allSubsidiaries')}</option>{options.subsidiaries.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field> : null}
      <CountryField label={t('fields.country')} placeholder={t('select')} value={form.country ?? ''} onChange={(value) => set('country', value)} /></div>
    {secretFields.length ? <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800"><div><h3 className="text-sm font-semibold">{t('originator.title')}</h3><p className="text-xs text-slate-500">{creating ? t('originator.newHint') : t('originator.editHint')}</p></div><div className="grid gap-4 sm:grid-cols-2">{secretFields.map((key) => <Field key={key} label={t(`secretFields.${key}`)}><Input type="password" autoComplete="new-password" value={secrets[key] ?? ''} onChange={(e) => secretSet(key, e.target.value)} /></Field>)}</div></div> : null}
    <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800"><h3 className="text-sm font-semibold">{t('accounting.title')}</h3><Field label={t('fields.discountAccount')}><Select value={settings.discountAccountId ?? ''} onChange={(e) => settingSet('discountAccountId', e.target.value || null)}><option value="">{t('accounting.noDiscountAccount')}</option>{options.accountingAccounts.map((a) => <option key={a.id} value={a.id}>{[a.number, a.name].filter(Boolean).join(' · ')}</option>)}</Select></Field>{format?.rail === 'positive_pay' ? <Field label={t('fields.positivePayAccountReference')}><Input value={settings.positivePayAccountReference ?? ''} onChange={(e) => settingSet('positivePayAccountReference', e.target.value)} /></Field> : null}<p className="text-xs text-slate-500">{t('accounting.hint')}</p></div>
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"><h3 className="mb-3 text-sm font-semibold">{t('delivery.title')}</h3><div className="grid gap-4 sm:grid-cols-2"><Field label={t('fields.sftpServer')}><Select value={form.sftp_server_id ?? form.sftpServerId ?? ''} onChange={(e) => set('sftpServerId', e.target.value || null)}><option value="">{t('delivery.manual')}</option>{options.sftpServers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field><Field label={t('fields.sftpFolder')}><Input value={form.sftp_folder ?? form.sftpFolder ?? ''} onChange={(e) => set('sftpFolder', e.target.value)} placeholder="outbound" /></Field></div><p className="mt-2 text-xs text-slate-500">{t('delivery.existingSftpHint')}</p></div>
    <div className="space-y-2"><Toggle checked={form.require_run_approval ?? form.requireRunApproval ?? true} onChange={(v) => set('requireRunApproval', v)} label={t('fields.requireRunApproval')} /><Toggle checked={form.require_file_approval ?? form.requireFileApproval ?? false} onChange={(v) => set('requireFileApproval', v)} label={t('fields.requireFileApproval')} /><Toggle checked={form.auto_remittance ?? form.autoRemittance ?? false} onChange={(v) => set('autoRemittance', v)} label={t('fields.autoRemittance')} /><Toggle checked={form.is_active ?? form.isActive ?? true} onChange={(v) => set('isActive', v)} label={t('fields.active')} /></div>
  </>
}

function FormatFields({ form, set, options, t, creating, multiCurrency = false }: { form: Record<string, any>; set: (k: string, v: any) => void; options: Options; t: any; creating: boolean; multiCurrency?: boolean }) {
  const custom = creating || form.rail === 'custom'
  return <><div className="grid gap-4 sm:grid-cols-2"><Field label={t('fields.code')}><Input disabled={!creating} value={form.code ?? ''} onChange={(e) => set('code', e.target.value.toUpperCase())} /></Field><Field label={t('fields.name')}><Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field></div>
    <div className="grid gap-4 sm:grid-cols-2"><Field label={t('fields.direction')}><Select disabled={!custom} value={form.direction ?? 'credit'} onChange={(e) => set('direction', e.target.value)}><option value="credit">{t('directions.credit')}</option><option value="debit">{t('directions.debit')}</option><option value="both">{t('directions.both')}</option></Select></Field>{multiCurrency ? <CurrencyField label={t('fields.currency')} currencies={options.currencies} value={form.currency ?? ''} onChange={(v) => set('currency', v)} allowInherit /> : null}</div>
    <div className="grid gap-4 sm:grid-cols-3"><CountryField label={t('fields.country')} placeholder={t('select')} value={form.country ?? ''} onChange={(value) => set('country', value)} /><Field label={t('fields.extension')}><Input value={form.file_extension ?? form.fileExtension ?? 'txt'} onChange={(e) => set('fileExtension', e.target.value)} /></Field><Field label={t('fields.contentType')}><Input value={form.content_type ?? form.contentType ?? 'text/plain; charset=utf-8'} onChange={(e) => set('contentType', e.target.value)} /></Field></div>
    {custom ? <Field label={t('fields.formatterScript')}><Textarea rows={16} className="font-mono text-xs" spellCheck={false} value={form.formatter_script ?? form.formatterScript ?? 'function main(ctx) {\n  return {\n    filename: `PAY-${ctx.request.run.run_number}.txt`,\n    content: "",\n    contentType: "text/plain"\n  };\n}'} onChange={(e) => set('formatterScript', e.target.value)} /></Field> : <p className="rounded-lg bg-slate-100 p-3 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">{t('builtInFormatHint')}</p>}
    <Toggle checked={form.is_active ?? form.isActive ?? true} onChange={(v) => set('isActive', v)} label={t('fields.active')} /></>
}

function ScheduleFields({ form, set, options, t }: { form: Record<string, any>; set: (k: string, v: any) => void; options: Options; t: any }) {
  const criteria = form.selection_criteria ?? form.selectionCriteria ?? {}
  const setCriteria = (key: string, value: unknown) => set('selectionCriteria', { ...criteria, [key]: value })
  return <><Field label={t('fields.name')}><Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field><Field label={t('fields.profile')}><Select value={form.payment_bank_profile_id ?? form.paymentBankProfileId ?? ''} onChange={(e) => set('paymentBankProfileId', e.target.value)}><option value="">{t('select')}</option>{options.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
    <div className="grid gap-4 sm:grid-cols-2"><Field label={t('fields.cron')}>
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        {([['daily', '0 8 * * *'], ['weekdays', '0 8 * * 1-5'], ['weekly', '0 8 * * 1'], ['monthly', '0 8 1 * *']] as const).map(([key, expr]) => (
          <button key={key} type="button" onClick={() => set('cron', expr)}
            className={cn('rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
              (form.cron ?? '') === expr ? 'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-400 dark:bg-teal-950/40 dark:text-teal-300'
                : 'border-slate-300 text-slate-500 hover:border-slate-400 dark:border-slate-700 dark:text-slate-400')}>
            {t(`schedulePresets.${key}`)}
          </button>
        ))}
      </div>
      <Input className="font-mono" value={form.cron ?? ''} onChange={(e) => set('cron', e.target.value)} placeholder="0 8 * * 1" />
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('fields.cronHint')}</p>
    </Field><Field label={t('fields.timezone')}><Input value={form.timezone ?? 'UTC'} onChange={(e) => set('timezone', e.target.value)} /></Field></div>
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"><h3 className="mb-3 text-sm font-semibold">{t('criteria.title')}</h3><div className="grid gap-4 sm:grid-cols-2"><Field label={t('criteria.dueThroughDays')}><Input type="number" min={0} value={criteria.dueThroughDays ?? 0} onChange={(e) => setCriteria('dueThroughDays', Number(e.target.value))} /></Field><Field label={t('criteria.minimumAmount')}><Input type="number" min={0} step="0.01" value={criteria.minimumAmount ?? ''} onChange={(e) => setCriteria('minimumAmount', e.target.value)} /></Field><Field label={t('criteria.maximumRunAmount')}><Input type="number" min={0} step="0.01" value={criteria.maximumRunAmount ?? ''} onChange={(e) => setCriteria('maximumRunAmount', e.target.value)} /></Field></div><div className="mt-3 space-y-2"><Toggle checked={criteria.captureDiscounts !== false} onChange={(v) => setCriteria('captureDiscounts', v)} label={t('criteria.captureDiscounts')} /><Toggle checked={criteria.applyCredits !== false} onChange={(v) => setCriteria('applyCredits', v)} label={t('criteria.applyCredits')} /></div></div>
    <Field label={t('fields.action')}><Select value={form.action ?? 'create_draft'} onChange={(e) => set('action', e.target.value)}><option value="create_draft">{t('actions.create_draft')}</option><option value="submit_for_approval">{t('actions.submit_for_approval')}</option></Select></Field><Toggle checked={form.is_active ?? form.isActive ?? true} onChange={(v) => set('isActive', v)} label={t('fields.active')} /></>
}

function MandateFields({ form, set, options, t, creating }: { form: Record<string, any>; set: (k: string, v: any) => void; options: Options; t: any; creating: boolean }) {
  const partyId = form.party_id ?? form.partyId ?? ''
  const party = options.parties.find((p) => p.id === partyId)
  return <><Field label={t('fields.party')}><Select disabled={!creating} value={partyId} onChange={(e) => { set('partyId', e.target.value); set('partyBankAccountId', '') }}><option value="">{t('select')}</option>{options.parties.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}</Select></Field><Field label={t('fields.partyBankAccount')}><Select disabled={!creating || !party} value={form.party_bank_account_id ?? form.partyBankAccountId ?? ''} onChange={(e) => set('partyBankAccountId', e.target.value)}><option value="">{t('select')}</option>{party?.bank_accounts?.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</Select></Field>
    <div className="grid gap-4 sm:grid-cols-2"><Field label={t('fields.scheme')}><Select disabled={!creating} value={form.scheme ?? 'nacha'} onChange={(e) => set('scheme', e.target.value)}><option value="nacha">{t('schemes.nacha')}</option><option value="sepa_core">{t('schemes.sepa_core')}</option><option value="sepa_b2b">{t('schemes.sepa_b2b')}</option><option value="custom">{t('schemes.custom')}</option></Select></Field><Field label={t('fields.reference')}><Input disabled={!creating} value={form.mandate_reference ?? form.mandateReference ?? ''} onChange={(e) => set('mandateReference', e.target.value)} /></Field></div>
    <Field label={t('fields.status')}><Select value={form.status ?? 'pending'} onChange={(e) => set('status', e.target.value)}>{['pending', 'active', 'suspended', 'revoked', 'expired'].map((s) => <option key={s} value={s}>{t(`states.${s}`)}</option>)}</Select></Field>
    <div className="grid gap-4 sm:grid-cols-3"><Field label={t('fields.signedOn')}><Input type="date" value={form.signed_on ?? form.signedOn ?? ''} onChange={(e) => set('signedOn', e.target.value)} /></Field><Field label={t('fields.validFrom')}><Input type="date" value={form.valid_from ?? form.validFrom ?? ''} onChange={(e) => set('validFrom', e.target.value)} /></Field><Field label={t('fields.expiresOn')}><Input type="date" value={form.expires_on ?? form.expiresOn ?? ''} onChange={(e) => set('expiresOn', e.target.value)} /></Field></div></>
}
