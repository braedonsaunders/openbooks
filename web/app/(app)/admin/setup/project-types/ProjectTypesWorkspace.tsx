'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { BookOpen, ChevronDown, ChevronUp, Plus, Trash2, X } from 'lucide-react'
import { Badge, Button, Card, CardContent, Input, Label, Select, Textarea, cn } from '@openbooks/ui'
import type { FinancialProfile, InvoicingProfile, BackupProfile } from '@openbooks/schema'

export interface ProjectTypeRow {
  id: string
  key: string
  name: string
  description: string | null
  isBuiltIn: boolean
  isActive: boolean
  sortOrder: number
  billingMethod: string | null
  financialProfile: FinancialProfile
  financialProfileEffectiveFrom: string | null
  invoicingProfile: InvoicingProfile
  backupProfile: BackupProfile
}

type SubTab = 'general' | 'profitability' | 'invoicing' | 'backup'
const SUBTABS: SubTab[] = ['general', 'profitability', 'invoicing', 'backup']

// Friendly labels for enum tokens that plain title-casing would mangle
// (acronyms/abbreviations like "je", "tm", "wbs", "pct").
const LABELS: Record<string, string> = {
  payroll_je: 'Payroll journal entry',
  tm_actual: 'Time & materials actuals',
  wbs_estimates: 'WBS estimates',
  margin_pct: 'Margin %',
  in_actual_cost: 'From actual cost',
  time_and_materials: 'Time & materials',
  rate_engine: 'Department rate card',
  percent_of_labor: '% of labor cost',
  per_labor_hour: '$ per labor hour',
  account_group_actual: 'Posted GL (account group)',
  billed_hours: 'Billable hours only',
  total_hours: 'All hours',
  could_be_invoiced: 'Could be invoiced',
  percent_complete_cost: 'Percent complete (cost)',
  application_for_payment: 'Applications for payment (SOV / retainage)',
  standard: 'Standard billing requests',
}
const humanize = (v: string) => LABELS[v] ?? v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

const BILLING_METHODS = ['', 'time_and_materials', 'fixed_price', 'cost_plus']
const BILLING_PROCEDURES = ['standard', 'application_for_payment']
const COST_SOURCES = ['account_types', 'account_group']
const LABOR_SOURCES = ['in_actual_cost', 'time_rate', 'estimated_time_rate', 'payroll_je', 'account_group']
const OVERHEAD_METHODS = ['none', 'percent_of_labor', 'per_labor_hour', 'rate_engine', 'account_group_actual']
const ENGINE_DEFAULT = { rateSource: 'standard', hoursBasis: 'total_hours', dimension: 'overhead', scope: 'department' } as const
const PRICE_METHODS = ['contract_field', 'billable_value', 'not_to_exceed', 'cost_plus']
const CBI_FORMULAS = ['price_minus_invoiced', 'unbilled_billable']
const BUDGET_SOURCES = ['wbs_estimates', 'none']
const COMMIT_KINDS = ['purchase_order', 'sales_order']
const BASES = ['time_selection', 'date_range', 'draw_amount', 'milestone', 'field_ticket']
/** Documents a tenant may treat as a source of rebillable job cost. */
const COST_SOURCE_KINDS = ['vendor_bill', 'expense_report', 'card_charge', 'check', 'sales_order', 'purchase_order']
const MARKUP_PRESENTATIONS = ['embedded', 'lump_sum']
const LINE_BUILDERS = ['tm_actual', 'milestone', 'draw', 'cost_plus']
const REVENUE_ACCTS = ['item_income', 'unbilled_receivable', 'fixed']
const RECOGNITIONS = ['as_invoiced', 'percent_complete_cost', 'milestone']
const BACKUP_TYPES = ['costed_timesheets', 'timesheets_purchases', 'purchases', 'purchases_shop_time', 'quote_only', 'none']
const MEASURE_KEYS = ['invoiced_to_date', 'revenue_posted', 'could_be_invoiced', 'total_price', 'actual_cost', 'labor_cost', 'overhead', 'committed_cost', 'total_cost', 'billable_value', 'unbilled_billable', 'cost_budget', 'remaining_budget', 'gross_profit', 'margin_pct']
const VARIANTS = ['line', 'subtotal', 'total']

function EnumField({ label, value, options, onChange, disabled = false }: { label: string; value: string; options: string[]; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{o === '' ? '—' : humanize(o)}</option>)}
      </Select>
    </div>
  )
}

function Chips({ label, all, selected, onToggle }: { label: string; all: string[]; selected: string[]; onToggle: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {all.map((o) => {
          const on = selected.includes(o)
          return (
            <button key={o} type="button" onClick={() => onToggle(o)}
              className={cn('rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                on ? 'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-400 dark:bg-teal-950/40 dark:text-teal-300'
                   : 'border-slate-300 text-slate-500 hover:border-slate-400 dark:border-slate-700 dark:text-slate-400')}>
              {humanize(o)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

const BLANK = (t: string, name: string): ProjectTypeRow => ({
  id: 'new', key: '', name, description: '', isBuiltIn: false, isActive: true, sortOrder: 50, billingMethod: null,
  financialProfileEffectiveFrom: null,
  financialProfile: {
    invoicedToDate: { docKinds: ['customer_invoice'], creditKinds: ['customer_credit'] },
    actualCost: { source: 'account_types', accountTypes: ['expense', 'cogs', 'expense_other', 'expense_deferred'] },
    laborCost: { source: 'in_actual_cost' },
    overhead: { method: 'none' },
    committedCost: { docKinds: ['purchase_order'] },
    billableValue: { includeUnbilledTime: true, includeUnbilledCostLines: true, timeRate: 'bill_rate' },
    costBudget: { source: 'wbs_estimates' },
    totalPrice: { method: 'billable_value' },
    couldBeInvoiced: { formula: 'unbilled_billable' },
    totalCost: { components: ['actual_cost', 'committed_cost'] },
    layout: [
      { measure: 'invoiced_to_date', variant: 'line' }, { measure: 'could_be_invoiced', variant: 'line' },
      { measure: 'total_price', variant: 'subtotal' }, { measure: 'actual_cost', variant: 'line' },
      { measure: 'committed_cost', variant: 'line' }, { measure: 'total_cost', variant: 'subtotal' },
      { measure: 'cost_budget', variant: 'line' }, { measure: 'remaining_budget', variant: 'line' },
      { measure: 'gross_profit', variant: 'total' },
    ],
  },
  invoicingProfile: { billingProcedure: 'standard', allowedBases: ['time_selection', 'date_range'], defaultBasis: 'time_selection', lineBuilder: 'tm_actual', revenueAccount: 'item_income', recognition: 'as_invoiced' },
  backupProfile: { required: true, defaultBackupType: 'costed_timesheets', allowedBackupTypes: ['costed_timesheets', 'purchases', 'none'] },
})

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

export function ProjectTypesWorkspace({ types, dimensions }: { types: ProjectTypeRow[]; dimensions: string[]; incomeAccounts: { id: string; number: string; name: string }[] }) {
  const t = useTranslations('projectTypes')
  const tCommon = useTranslations('common')
  const tMeasures = useTranslations('projects.measures')
  const router = useRouter()
  const [list, setList] = useState(types)
  const [selId, setSelId] = useState<string>(types[0]?.id ?? 'new')
  const [sub, setSub] = useState<SubTab>('general')
  const [busy, setBusy] = useState(false)
  const [financialEffectiveFrom, setFinancialEffectiveFrom] = useState(new Date().toISOString().slice(0, 10))
  const [financialChangeReason, setFinancialChangeReason] = useState('')

  const selected = useMemo(() => (selId === 'new' ? BLANK(t('newTypeName'), t('newTypeName')) : list.find((x) => x.id === selId)) ?? list[0], [selId, list, t])
  const [draft, setDraft] = useState<ProjectTypeRow>(selected)
  // Re-sync draft when selection changes.
  const [lastSel, setLastSel] = useState(selId)
  if (lastSel !== selId) {
    setLastSel(selId)
    setDraft(selected)
    setFinancialEffectiveFrom(new Date().toISOString().slice(0, 10))
    setFinancialChangeReason('')
  }

  const fp = draft.financialProfile, ip = draft.invoicingProfile, bp = draft.backupProfile
  const financialChanged = draft.id !== 'new' && stableJson(fp) !== stableJson(selected?.financialProfile)
  const setFp = (patch: Partial<FinancialProfile>) => setDraft({ ...draft, financialProfile: { ...fp, ...patch } })
  const setIp = (patch: Partial<InvoicingProfile>) => setDraft({ ...draft, invoicingProfile: { ...ip, ...patch } })
  const setBp = (patch: Partial<BackupProfile>) => setDraft({ ...draft, backupProfile: { ...bp, ...patch } })
  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

  async function save() {
    if (financialChanged && financialChangeReason.trim().length < 8) {
      setSub('profitability')
      return toast.error(t('financialChangeReasonRequired'))
    }
    setBusy(true)
    const isNew = draft.id === 'new'
    const res = await fetch('/api/admin/setup/project-types', {
      method: isNew ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...draft,
        key: draft.key || draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        ...(financialChanged ? { financialEffectiveFrom, financialChangeReason } : {}),
      }),
    })
    const data = await res.json()
    setBusy(false)
    if (!res.ok) return toast.error(data.error ?? 'Save failed')
    toast.success(t('saved'))
    if (!isNew) {
      const saved = {
        ...draft,
        financialProfileEffectiveFrom: financialChanged
          ? financialEffectiveFrom
          : draft.financialProfileEffectiveFrom,
      }
      setList(list.map((row) => (row.id === saved.id ? saved : row)))
      setDraft(saved)
      setFinancialChangeReason('')
    }
    router.refresh()
    if (isNew && data.id) {
      const created = {
        ...draft,
        id: data.id as string,
        financialProfileEffectiveFrom: new Date().toISOString().slice(0, 10),
      }
      setList([...list, created])
      setDraft(created)
      setSelId(data.id)
    }
  }

  async function remove() {
    if (!confirm(t('deleteConfirm', { name: draft.name }))) return
    setBusy(true)
    const res = await fetch(`/api/admin/setup/project-types?id=${draft.id}`, { method: 'DELETE' })
    setBusy(false)
    if (!res.ok) return toast.error((await res.json()).error ?? 'Delete failed')
    setList(list.filter((x) => x.id !== draft.id))
    setSelId(list[0]?.id ?? 'new')
    router.refresh()
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
      {/* Type list */}
      <div className="space-y-1">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('types')}</h2>
          <Button variant="outline" size="sm" onClick={() => setSelId('new')}><Plus size={14} /> {t('newType')}</Button>
        </div>
        {list.map((ty) => (
          <button key={ty.id} type="button" onClick={() => setSelId(ty.id)}
            className={cn('flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
              selId === ty.id ? 'bg-teal-50 font-medium text-teal-800 dark:bg-teal-950/40 dark:text-teal-200' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}>
            <span className="truncate">{ty.name}</span>
            <span className="flex shrink-0 items-center gap-1">
              {ty.isBuiltIn ? <Badge variant="secondary">{t('builtIn')}</Badge> : null}
              {!ty.isActive ? <Badge variant="outline">{tCommon('status.inactive')}</Badge> : null}
            </span>
          </button>
        ))}
        {selId === 'new' ? (
          <div className="rounded-md bg-teal-50 px-3 py-2 text-sm font-medium text-teal-800 dark:bg-teal-950/40 dark:text-teal-200">{t('newTypeName')}</div>
        ) : null}
      </div>

      {/* Editor */}
      <Card>
        <CardContent className="space-y-5 p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800">
              {SUBTABS.map((s) => (
                <button key={s} type="button" onClick={() => setSub(s)}
                  className={cn('border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                    sub === s ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400')}>
                  {t(`tabs.${s}`)}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Link href="/docs/project-types" className="flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
                <BookOpen size={13} aria-hidden /> {t('help')}
              </Link>
              {draft.id !== 'new' ? <Button variant="ghost" size="sm" disabled={busy} onClick={remove}><Trash2 size={14} /> {tCommon('actions.delete')}</Button> : null}
              <Button size="sm" disabled={busy || !draft.name.trim()} onClick={save}>{busy ? tCommon('actions.saving') : tCommon('actions.save')}</Button>
            </div>
          </div>

          {sub === 'general' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>{tCommon('labels.name')}</Label><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>{t('key')}</Label><Input value={draft.key} disabled={draft.isBuiltIn} className="font-mono" placeholder="auto" onChange={(e) => setDraft({ ...draft, key: e.target.value })} /></div>
              <div className="space-y-1.5 sm:col-span-2"><Label>{tCommon('labels.description')}</Label><Textarea value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
              <EnumField label={t('billingMethod')} value={draft.billingMethod ?? ''} options={BILLING_METHODS}
                disabled={ip.billingProcedure === 'application_for_payment'}
                onChange={(v) => setDraft({ ...draft, billingMethod: v || null })} />
              <div className="space-y-1.5"><Label>{t('sortOrder')}</Label><Input inputMode="numeric" value={String(draft.sortOrder)} onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) || 0 })} /></div>
              <EnumField label={tCommon('labels.status')} value={draft.isActive ? 'active' : 'inactive'} options={['active', 'inactive']} onChange={(v) => setDraft({ ...draft, isActive: v === 'active' })} />
            </div>
          ) : null}

          {sub === 'profitability' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {draft.id !== 'new' ? (
                <div className="sm:col-span-2 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40">
                  <p className="text-xs leading-5 text-slate-600 dark:text-slate-300">
                    {t('financialPolicyEffective', {
                      date: draft.financialProfileEffectiveFrom ?? t('legacySeed'),
                    })}
                  </p>
                  {financialChanged ? (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label>{t('financialEffectiveFrom')}</Label>
                        <Input
                          type="date"
                          min={new Date().toISOString().slice(0, 10)}
                          value={financialEffectiveFrom}
                          onChange={(e) => setFinancialEffectiveFrom(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t('financialChangeReason')}</Label>
                        <Input
                          value={financialChangeReason}
                          onChange={(e) => setFinancialChangeReason(e.target.value)}
                          placeholder={t('financialChangeReasonPlaceholder')}
                        />
                      </div>
                      <p className="sm:col-span-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                        {t('financialVersionNotice')}
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <EnumField label={t('priceMethod')} value={fp.totalPrice.method} options={PRICE_METHODS} onChange={(v) => setFp({ totalPrice: { ...fp.totalPrice, method: v as any } })} />
              <EnumField label={t('cbiFormula')} value={fp.couldBeInvoiced.formula} options={CBI_FORMULAS} onChange={(v) => setFp({ couldBeInvoiced: { formula: v as any } })} />
              <EnumField label={t('costSource')} value={fp.actualCost.source} options={COST_SOURCES} onChange={(v) => setFp({ actualCost: { ...fp.actualCost, source: v as any } })} />
              {fp.actualCost.source === 'account_group' ? <EnumField label={t('costDimension')} value={fp.actualCost.dimension ?? ''} options={['', ...dimensions]} onChange={(v) => setFp({ actualCost: { ...fp.actualCost, dimension: v || undefined } })} /> : <div />}
              <EnumField label={t('laborSource')} value={fp.laborCost.source} options={LABOR_SOURCES} onChange={(v) => setFp({ laborCost: { ...fp.laborCost, source: v as any } })} />
              <EnumField label={t('overheadMethod')} value={fp.overhead.method} options={OVERHEAD_METHODS} onChange={(v) => {
                const method = v as FinancialProfile['overhead']['method']
                setFp({
                  overhead: {
                    ...fp.overhead,
                    method,
                    ...(method === 'percent_of_labor' ? { ratePercent: fp.overhead.ratePercent ?? 0 } : {}),
                    ...(method === 'per_labor_hour' ? { ratePerHour: fp.overhead.ratePerHour ?? 0 } : {}),
                    ...(method === 'rate_engine' ? { rateEngine: fp.overhead.rateEngine ?? ENGINE_DEFAULT } : {}),
                  },
                })
              }} />
              {fp.overhead.method === 'percent_of_labor' ? (
                <div className="space-y-1.5"><Label>{t('overheadRatePercent')}</Label><Input type="number" step="0.01" value={fp.overhead.ratePercent ?? ''} onChange={(e) => setFp({ overhead: { ...fp.overhead, ratePercent: e.target.value === '' ? undefined : Number(e.target.value) } })} /></div>
              ) : fp.overhead.method === 'per_labor_hour' ? (
                <div className="space-y-1.5"><Label>{t('overheadRatePerHour')}</Label><Input type="number" step="0.01" value={fp.overhead.ratePerHour ?? ''} onChange={(e) => setFp({ overhead: { ...fp.overhead, ratePerHour: e.target.value === '' ? undefined : Number(e.target.value) } })} /></div>
              ) : fp.overhead.method === 'account_group_actual' ? (
                <EnumField label={t('overheadDimension')} value={fp.overhead.accountGroup?.dimension ?? ''} options={['', ...dimensions]} onChange={(v) => setFp({ overhead: { ...fp.overhead, accountGroup: { dimension: v } } })} />
              ) : <div />}
              {fp.overhead.method === 'rate_engine' ? (
                <>
                  <EnumField label={t('overheadHoursBasis')} value={fp.overhead.rateEngine?.hoursBasis ?? 'billed_hours'} options={['billed_hours', 'actual_hours', 'total_hours']} onChange={(v) => setFp({ overhead: { ...fp.overhead, rateEngine: { ...ENGINE_DEFAULT, ...fp.overhead.rateEngine, hoursBasis: v as any } } })} />
                  <EnumField label={t('overheadScope')} value={fp.overhead.rateEngine?.scope ?? 'department'} options={['flat', 'department', 'class']} onChange={(v) => setFp({ overhead: { ...fp.overhead, rateEngine: { ...ENGINE_DEFAULT, ...fp.overhead.rateEngine, scope: v as any } } })} />
                  <p className="sm:col-span-2 text-xs text-slate-500 dark:text-slate-400">{t('overheadRateEngineHint')}</p>
                </>
              ) : null}
              <EnumField label={t('budgetSource')} value={fp.costBudget.source} options={BUDGET_SOURCES} onChange={(v) => setFp({ costBudget: { source: v as any } })} />
              <div className="sm:col-span-2"><Chips label={t('committedKinds')} all={COMMIT_KINDS} selected={fp.committedCost.docKinds} onToggle={(v) => setFp({ committedCost: { docKinds: toggle(fp.committedCost.docKinds, v) } })} /></div>
              <div className="sm:col-span-2"><Chips label={t('costSourceKinds')} all={COST_SOURCE_KINDS} selected={fp.billableValue.costSourceKinds ?? ['vendor_bill', 'expense_report', 'card_charge', 'check']} onToggle={(v) => setFp({ billableValue: { ...fp.billableValue, costSourceKinds: toggle(fp.billableValue.costSourceKinds ?? ['vendor_bill', 'expense_report', 'card_charge', 'check'], v) } })} /></div>
              <div className="sm:col-span-2"><Chips label={t('totalCostComponents')} all={['actual_cost', 'committed_cost', 'labor_cost', 'overhead']} selected={fp.totalCost.components} onToggle={(v) => setFp({ totalCost: { components: toggle(fp.totalCost.components, v) as any } })} /></div>

              {/* P&L statement layout editor */}
              <div className="sm:col-span-2 space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
                <div className="flex items-center justify-between">
                  <Label>{t('layout')}</Label>
                  <Button variant="outline" size="sm" onClick={() => setFp({ layout: [...fp.layout, { measure: 'invoiced_to_date', variant: 'line' }] })}><Plus size={14} /> {t('addLine')}</Button>
                </div>
                <div className="space-y-1.5">
                  {fp.layout.map((line, i) => {
                    const upd = (patch: Partial<typeof line>) => setFp({ layout: fp.layout.map((l, j) => (j === i ? { ...l, ...patch } : l)) })
                    const move = (d: number) => { const next = [...fp.layout]; const [x] = next.splice(i, 1); next.splice(i + d, 0, x); setFp({ layout: next }) }
                    return (
                      <div key={i} className="flex items-center gap-2 rounded-md border border-slate-200 p-1.5 dark:border-slate-800">
                        <Select value={line.measure} onChange={(e) => upd({ measure: e.target.value as any })} className="flex-1">
                          {MEASURE_KEYS.map((m) => <option key={m} value={m}>{tMeasures(m as never)}</option>)}
                        </Select>
                        <Select value={line.variant} onChange={(e) => upd({ variant: e.target.value as any })} className="w-32">
                          {VARIANTS.map((v) => <option key={v} value={v}>{t(`variant.${v}`)}</option>)}
                        </Select>
                        <button type="button" disabled={i === 0} onClick={() => move(-1)} className="rounded p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 dark:hover:text-slate-200" aria-label={t('moveUp')}><ChevronUp size={16} /></button>
                        <button type="button" disabled={i === fp.layout.length - 1} onClick={() => move(1)} className="rounded p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 dark:hover:text-slate-200" aria-label={t('moveDown')}><ChevronDown size={16} /></button>
                        <button type="button" onClick={() => setFp({ layout: fp.layout.filter((_, j) => j !== i) })} className="rounded p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400" aria-label={t('removeLine')}><X size={16} /></button>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          ) : null}

          {sub === 'invoicing' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <EnumField label={t('billingProcedure')} value={ip.billingProcedure ?? 'standard'} options={BILLING_PROCEDURES} onChange={(v) => {
                if (v === 'application_for_payment') {
                  setDraft({
                    ...draft,
                    billingMethod: 'fixed_price',
                    invoicingProfile: {
                      ...ip,
                      billingProcedure: 'application_for_payment',
                      allowedBases: ['draw_amount'],
                      defaultBasis: 'draw_amount',
                      lineBuilder: 'draw',
                    },
                  })
                } else {
                  setIp({ billingProcedure: 'standard' })
                }
              }} />
              <div className="text-xs leading-5 text-slate-500 dark:text-slate-400">{t('billingProcedureHint')}</div>
              {ip.billingProcedure === 'application_for_payment' ? (
                <div className="sm:col-span-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs leading-5 text-teal-800 dark:border-teal-900 dark:bg-teal-950/30 dark:text-teal-200">
                  {t('applicationProcedureControls')}
                </div>
              ) : (
                <>
                  <div className="sm:col-span-2"><Chips label={t('allowedBases')} all={BASES} selected={ip.allowedBases} onToggle={(v) => setIp({ allowedBases: toggle(ip.allowedBases, v) })} /></div>
                  <EnumField label={t('defaultBasis')} value={ip.defaultBasis} options={ip.allowedBases} onChange={(v) => setIp({ defaultBasis: v })} />
                  <EnumField label={t('lineBuilder')} value={ip.lineBuilder} options={LINE_BUILDERS} onChange={(v) => setIp({ lineBuilder: v as any })} />
                </>
              )}
              <EnumField label={t('revenueAccount')} value={ip.revenueAccount} options={REVENUE_ACCTS} onChange={(v) => setIp({ revenueAccount: v as any })} />
              <EnumField label={t('recognition')} value={ip.recognition} options={RECOGNITIONS} onChange={(v) => setIp({ recognition: v as any })} />

              {/* Which documents supply rebillable job cost. Businesses stage priced
                  billable items differently — purchase documents, or orders. */}
              <div className="sm:col-span-2">
                <Chips label={t('costSourceKinds')} all={COST_SOURCE_KINDS}
                  selected={ip.costSourceKinds ?? ['vendor_bill', 'expense_report', 'card_charge', 'check']}
                  onToggle={(v) => setIp({ costSourceKinds: toggle(ip.costSourceKinds ?? ['vendor_bill', 'expense_report', 'card_charge', 'check'], v) })} />
              </div>

              <EnumField label={t('markupPresentation')} value={ip.markupPresentation ?? 'embedded'} options={MARKUP_PRESENTATIONS}
                onChange={(v) => setIp({ markupPresentation: v as any })} />
              <EnumField label={t('notToExceed')} value={ip.notToExceed ? 'yes' : 'no'} options={['no', 'yes']}
                onChange={(v) => setIp({ notToExceed: v === 'yes' })} />
              <EnumField label={t('rateCardLapse')} value={ip.rateCardLapse ?? 'block'}
                options={['block', 'carry_forward']}
                onChange={(v) => setIp({ rateCardLapse: v as 'block' | 'carry_forward' })} />

            </div>
          ) : null}

          {sub === 'backup' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <EnumField label={t('backupRequired')} value={bp.required ? 'yes' : 'no'} options={['yes', 'no']} onChange={(v) => setBp({ required: v === 'yes' })} />
              <EnumField label={t('defaultBackupType')} value={bp.defaultBackupType} options={BACKUP_TYPES} onChange={(v) => setBp({ defaultBackupType: v })} />
              <div className="sm:col-span-2"><Chips label={t('allowedBackupTypes')} all={BACKUP_TYPES} selected={bp.allowedBackupTypes} onToggle={(v) => setBp({ allowedBackupTypes: toggle(bp.allowedBackupTypes, v) })} /></div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
