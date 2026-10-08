'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import {
  Button,
  Input,
  Label,
  SearchSelect,
  Select,
  Textarea,
  UrlDrawer,
  cn,
} from '@openbooks/ui'
import { useAppAction } from '../../../../../lib/use-app-action'
import { countryOptions } from '../../../../../lib/countries'

export type PaymentSetupView = 'profiles' | 'formats' | 'schedules'

type Options = {
  formats: Array<{ id: string; name: string; rail: string; currency: string | null }>
  bankAccounts: Array<{ id: string; number: string | null; name: string }>
  accountingAccounts: Array<{ id: string; number: string | null; name: string }>
  subsidiaries: Array<{ id: string; name: string }>
  sftpServers: Array<{ id: string; name: string }>
  profiles: Array<{ id: string; name: string }>
  currencies: Array<{ code: string; name: string }>
}
type Translator = ReturnType<typeof useTranslations>
type SetupForm = {
  id?: string; name?: string; code?: string; rail?: string; direction?: string;
  currency?: string; country?: string; bank_account_id?: string; bankAccountId?: string;
  subsidiary_id?: string; subsidiaryId?: string; payment_format_id?: string; paymentFormatId?: string;
  sftp_server_id?: string; sftpServerId?: string; sftp_folder?: string; sftpFolder?: string;
  file_extension?: string; fileExtension?: string; content_type?: string; contentType?: string;
  formatter_script?: string; formatterScript?: string; payment_bank_profile_id?: string;
  paymentBankProfileId?: string; cron?: string; timezone?: string; action?: string;
  auto_remittance?: boolean; autoRemittance?: boolean; is_active?: boolean; isActive?: boolean;
  originatorSecrets?: Record<string, string>;
  settings?: { discountAccountId?: string | null; positivePayAccountReference?: string };
  selection_criteria?: { dueThroughDays?: number; minimumAmount?: string; maximumRunAmount?: string; captureDiscounts?: boolean; applyCredits?: boolean };
  selectionCriteria?: { dueThroughDays?: number; minimumAmount?: string; maximumRunAmount?: string; captureDiscounts?: boolean; applyCredits?: boolean };
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

// The create/edit drawer the payment setup pages place by name.
export function SetupEditor({ view, row, creating, options, closeHref, multiCurrency = false }: { view: PaymentSetupView; row: Record<string, unknown> | null; creating: boolean; options: Options; closeHref: string; multiCurrency?: boolean }) {
  const t = useTranslations('admin.setup.paymentOperations')
  const router = useRouter()
  const { busy, refusal, execute } = useAppAction()
  const initial = useMemo(() => row ?? {}, [row])
  const [form, setForm] = useState<SetupForm>(() => ({ ...initial } as SetupForm))
  const set = (key: string, value: unknown) => setForm((prev) => ({ ...prev, [key]: value }))
  const title = creating ? t(`drawer.new.${view}`) : t(`drawer.edit.${view}`)

  async function save() {
    const resource = view
    const payload = normalizePayload(view, form, multiCurrency)
    await execute(() => fetchAction(`/api/admin/payment-operations/${resource}${creating ? '' : `/${row!.id}`}`, {
        method: creating ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }), {
      fallbackMessage: t('saveFailed'),
      onOk: () => {
        toast.success(t('saved'))
        router.push(closeHref)
        router.refresh()
      },
    })
  }

  return (
    <UrlDrawer open closeHref={closeHref} size="lg" title={title} description={t(`drawer.description.${view}`)} footer={
      <div className="flex w-full justify-end gap-2"><Button variant="outline" onClick={() => router.push((closeHref))}>{t('cancel')}</Button><Button disabled={busy} onClick={save}>{busy ? t('saving') : t('save')}</Button></div>
    }>
      <div className="space-y-5 p-1">
        <ActionAlert error={refusal} fallbackMessage={t('saveFailed')} />
        {view === 'profiles' ? <ProfileFields form={form} set={set} options={options} t={t} creating={creating} multiCurrency={multiCurrency} /> : null}
        {view === 'formats' ? <FormatFields form={form} set={set} options={options} t={t} creating={creating} multiCurrency={multiCurrency} /> : null}
        {view === 'schedules' ? <ScheduleFields form={form} set={set} options={options} t={t} /> : null}
      </div>
    </UrlDrawer>
  )
}

function normalizePayload(view: PaymentSetupView, form: SetupForm, multiCurrency = false) {
  if (view === 'profiles') {
    const originatorSecrets = Object.fromEntries(Object.entries(form.originatorSecrets ?? {}).filter(([, value]) => String(value ?? '').trim()))
    return {
      name: form.name, bankAccountId: form.bank_account_id ?? form.bankAccountId,
      subsidiaryId: form.subsidiary_id ?? form.subsidiaryId ?? null,
      paymentFormatId: form.payment_format_id ?? form.paymentFormatId, ...(multiCurrency ? { currency: String(form.currency ?? '').toUpperCase() } : {}),
      country: form.country || null, ...(Object.keys(originatorSecrets).length ? { originatorSecrets } : {}),
      settings: form.settings ?? {}, sftpServerId: form.sftp_server_id ?? form.sftpServerId ?? null,
      sftpFolder: form.sftp_folder ?? form.sftpFolder ?? null,
      autoRemittance: form.auto_remittance ?? form.autoRemittance ?? false,
      isActive: form.is_active ?? form.isActive ?? true,
    }
  }
  if (view === 'formats') return { code: form.code, name: form.name, direction: form.direction, country: form.country, ...(multiCurrency ? { currency: form.currency } : {}), fileExtension: form.file_extension ?? form.fileExtension, contentType: form.content_type ?? form.contentType, formatterScript: form.formatter_script ?? form.formatterScript, isActive: form.is_active ?? form.isActive ?? true }
  return { name: form.name, paymentBankProfileId: form.payment_bank_profile_id ?? form.paymentBankProfileId, cron: form.cron, timezone: form.timezone, action: form.action, selectionCriteria: form.selection_criteria ?? form.selectionCriteria ?? {}, isActive: form.is_active ?? form.isActive ?? true }
}

function ProfileFields({ form, set, options, t, creating, multiCurrency = false }: { form: SetupForm; set: (k: string, v: unknown) => void; options: Options; t: Translator; creating: boolean; multiCurrency?: boolean }) {
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
    <Field label={t('fields.bankAccount')}><Select value={form.bank_account_id ?? form.bankAccountId ?? ''} onChange={(e) => set('bank_account_id', e.target.value)}><option value="">{t('select')}</option>{options.bankAccounts.map((a) => <option key={a.id} value={a.id}>{[a.number, a.name].filter(Boolean).join(' · ')}</option>)}</Select></Field>
    <Field label={t('fields.format')}><Select value={formatId} onChange={(e) => set('payment_format_id', e.target.value)}><option value="">{t('select')}</option>{options.formats.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select></Field>
    <div className="grid gap-4 sm:grid-cols-2">{options.subsidiaries.length > 0 ? <Field label={t('fields.subsidiary')}><Select value={form.subsidiary_id ?? form.subsidiaryId ?? ''} onChange={(e) => set('subsidiary_id', e.target.value || null)}><option value="">{t('allSubsidiaries')}</option>{options.subsidiaries.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field> : null}
      <CountryField label={t('fields.country')} placeholder={t('select')} value={form.country ?? ''} onChange={(value) => set('country', value)} /></div>
    {secretFields.length ? <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800"><div><h3 className="text-sm font-semibold">{t('originator.title')}</h3><p className="text-xs text-slate-500">{creating ? t('originator.newHint') : t('originator.editHint')}</p></div><div className="grid gap-4 sm:grid-cols-2">{secretFields.map((key) => <Field key={key} label={t(`secretFields.${key}`)}><Input type="password" autoComplete="new-password" value={secrets[key] ?? ''} onChange={(e) => secretSet(key, e.target.value)} /></Field>)}</div></div> : null}
    <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800"><h3 className="text-sm font-semibold">{t('accounting.title')}</h3><Field label={t('fields.discountAccount')}><Select value={settings.discountAccountId ?? ''} onChange={(e) => settingSet('discountAccountId', e.target.value || null)}><option value="">{t('accounting.noDiscountAccount')}</option>{options.accountingAccounts.map((a) => <option key={a.id} value={a.id}>{[a.number, a.name].filter(Boolean).join(' · ')}</option>)}</Select></Field>{format?.rail === 'positive_pay' ? <Field label={t('fields.positivePayAccountReference')}><Input value={settings.positivePayAccountReference ?? ''} onChange={(e) => settingSet('positivePayAccountReference', e.target.value)} /></Field> : null}<p className="text-xs text-slate-500">{t('accounting.hint')}</p></div>
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"><h3 className="mb-3 text-sm font-semibold">{t('delivery.title')}</h3><div className="grid gap-4 sm:grid-cols-2"><Field label={t('fields.sftpServer')}><Select value={form.sftp_server_id ?? form.sftpServerId ?? ''} onChange={(e) => set('sftp_server_id', e.target.value || null)}><option value="">{t('delivery.manual')}</option>{options.sftpServers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field><Field label={t('fields.sftpFolder')}><Input value={form.sftp_folder ?? form.sftpFolder ?? ''} onChange={(e) => set('sftp_folder', e.target.value)} placeholder="outbound" /></Field></div><p className="mt-2 text-xs text-slate-500">{t('delivery.existingSftpHint')}</p></div>
    <p className="text-xs text-slate-500 dark:text-slate-400">{t.rich('approvalHint', { flows: (chunks) => <Link href="/admin/flows" className="font-medium text-teal-700 hover:underline dark:text-teal-300">{chunks}</Link> })}</p><div className="space-y-2"><Toggle checked={form.auto_remittance ?? form.autoRemittance ?? false} onChange={(v) => set('auto_remittance', v)} label={t('fields.autoRemittance')} /><Toggle checked={form.is_active ?? form.isActive ?? true} onChange={(v) => set('is_active', v)} label={t('fields.active')} /></div>
  </>
}

function FormatFields({ form, set, options, t, creating, multiCurrency = false }: { form: SetupForm; set: (k: string, v: unknown) => void; options: Options; t: Translator; creating: boolean; multiCurrency?: boolean }) {
  const custom = creating || form.rail === 'custom'
  return <><div className="grid gap-4 sm:grid-cols-2"><Field label={t('fields.code')}><Input disabled={!creating} value={form.code ?? ''} onChange={(e) => set('code', e.target.value.toUpperCase())} /></Field><Field label={t('fields.name')}><Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field></div>
    <div className="grid gap-4 sm:grid-cols-2"><Field label={t('fields.direction')}><Select disabled={!custom} value={form.direction ?? 'credit'} onChange={(e) => set('direction', e.target.value)}><option value="credit">{t('directions.credit')}</option><option value="debit">{t('directions.debit')}</option><option value="both">{t('directions.both')}</option></Select></Field>{multiCurrency ? <CurrencyField label={t('fields.currency')} currencies={options.currencies} value={form.currency ?? ''} onChange={(v) => set('currency', v)} allowInherit /> : null}</div>
    <div className="grid gap-4 sm:grid-cols-3"><CountryField label={t('fields.country')} placeholder={t('select')} value={form.country ?? ''} onChange={(value) => set('country', value)} /><Field label={t('fields.extension')}><Input value={form.file_extension ?? form.fileExtension ?? 'txt'} onChange={(e) => set('file_extension', e.target.value)} /></Field><Field label={t('fields.contentType')}><Input value={form.content_type ?? form.contentType ?? 'text/plain; charset=utf-8'} onChange={(e) => set('content_type', e.target.value)} /></Field></div>
    {custom ? <Field label={t('fields.formatterScript')}><Textarea rows={16} className="font-mono text-xs" spellCheck={false} value={form.formatter_script ?? form.formatterScript ?? 'function main(ctx) {\n  return {\n    filename: `PAY-${ctx.request.run.run_number}.txt`,\n    content: "",\n    contentType: "text/plain"\n  };\n}'} onChange={(e) => set('formatter_script', e.target.value)} /></Field> : <p className="rounded-lg bg-slate-100 p-3 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">{t('builtInFormatHint')}</p>}
    <Toggle checked={form.is_active ?? form.isActive ?? true} onChange={(v) => set('is_active', v)} label={t('fields.active')} /></>
}

function ScheduleFields({ form, set, options, t }: { form: SetupForm; set: (k: string, v: unknown) => void; options: Options; t: Translator }) {
  const criteria = form.selection_criteria ?? form.selectionCriteria ?? {}
  const setCriteria = (key: string, value: unknown) => set('selection_criteria', { ...criteria, [key]: value })
  return <><Field label={t('fields.name')}><Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field><Field label={t('fields.profile')}><Select value={form.payment_bank_profile_id ?? form.paymentBankProfileId ?? ''} onChange={(e) => set('payment_bank_profile_id', e.target.value)}><option value="">{t('select')}</option>{options.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
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
    <Field label={t('fields.action')}><Select value={form.action ?? 'create_draft'} onChange={(e) => set('action', e.target.value)}><option value="create_draft">{t('actions.create_draft')}</option><option value="submit_for_approval">{t('actions.submit_for_approval')}</option></Select></Field><Toggle checked={form.is_active ?? form.isActive ?? true} onChange={(v) => set('is_active', v)} label={t('fields.active')} /></>
}
