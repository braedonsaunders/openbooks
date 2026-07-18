'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ChevronDown, ChevronUp, Plus, Trash2, X } from 'lucide-react'
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
  invoicingProfile: InvoicingProfile
  backupProfile: BackupProfile
}

type SubTab = 'general' | 'profitability' | 'invoicing' | 'backup'
const SUBTABS: SubTab[] = ['general', 'profitability', 'invoicing', 'backup']

const humanize = (v: string) => v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

const BILLING_METHODS = ['', 'time_and_materials', 'fixed_price', 'cost_plus']
const COST_SOURCES = ['account_types', 'account_group']
const LABOR_SOURCES = ['in_actual_cost', 'time_rate', 'payroll_je', 'account_group']
const BURDEN_SOURCES = ['none', 'account_group']
const PRICE_METHODS = ['contract_field', 'billable_value', 'not_to_exceed', 'cost_plus']
const CBI_FORMULAS = ['price_minus_invoiced', 'unbilled_billable']
const BUDGET_SOURCES = ['wbs_estimates', 'none']
const COMMIT_KINDS = ['purchase_order', 'sales_order']
const BASES = ['time_selection', 'date_range', 'draw_amount', 'milestone']
const LINE_BUILDERS = ['tm_actual', 'milestone', 'draw', 'cost_plus']
const REVENUE_ACCTS = ['item_income', 'unbilled_receivable', 'fixed']
const RECOGNITIONS = ['as_invoiced', 'percent_complete_cost', 'milestone']
const BACKUP_TYPES = ['costed_timesheets', 'timesheets_purchases', 'purchases', 'purchases_shop_time', 'quote_only', 'none']
const MEASURE_KEYS = ['invoiced_to_date', 'revenue_posted', 'could_be_invoiced', 'total_price', 'actual_cost', 'labor_cost', 'burden', 'committed_cost', 'total_cost', 'billable_value', 'unbilled_billable', 'cost_budget', 'remaining_budget', 'gross_profit', 'margin_pct']
const VARIANTS = ['line', 'subtotal', 'total']

function EnumField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
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
  financialProfile: {
    invoicedToDate: { docKinds: ['customer_invoice'], creditKinds: ['customer_credit'] },
    actualCost: { source: 'account_types', accountTypes: ['expense', 'cogs', 'expense_other', 'expense_deferred'] },
    laborCost: { source: 'in_actual_cost' },
    burden: { source: 'none' },
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
  invoicingProfile: { allowedBases: ['time_selection', 'date_range'], defaultBasis: 'time_selection', lineBuilder: 'tm_actual', revenueAccount: 'item_income', recognition: 'as_invoiced' },
  backupProfile: { required: true, defaultBackupType: 'costed_timesheets', allowedBackupTypes: ['costed_timesheets', 'purchases', 'none'] },
})

export function ProjectTypesWorkspace({ types, dimensions }: { types: ProjectTypeRow[]; dimensions: string[]; incomeAccounts: { id: string; number: string; name: string }[] }) {
  const t = useTranslations('projectTypes')
  const tCommon = useTranslations('common')
  const tMeasures = useTranslations('projects.measures')
  const router = useRouter()
  const [list, setList] = useState(types)
  const [selId, setSelId] = useState<string>(types[0]?.id ?? 'new')
  const [sub, setSub] = useState<SubTab>('general')
  const [busy, setBusy] = useState(false)

  const selected = useMemo(() => (selId === 'new' ? BLANK(t('newTypeName'), t('newTypeName')) : list.find((x) => x.id === selId)) ?? list[0], [selId, list, t])
  const [draft, setDraft] = useState<ProjectTypeRow>(selected)
  // Re-sync draft when selection changes.
  const [lastSel, setLastSel] = useState(selId)
  if (lastSel !== selId) { setLastSel(selId); setDraft(selected) }

  const fp = draft.financialProfile, ip = draft.invoicingProfile, bp = draft.backupProfile
  const setFp = (patch: Partial<FinancialProfile>) => setDraft({ ...draft, financialProfile: { ...fp, ...patch } })
  const setIp = (patch: Partial<InvoicingProfile>) => setDraft({ ...draft, invoicingProfile: { ...ip, ...patch } })
  const setBp = (patch: Partial<BackupProfile>) => setDraft({ ...draft, backupProfile: { ...bp, ...patch } })
  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

  async function save() {
    setBusy(true)
    const isNew = draft.id === 'new'
    const res = await fetch('/api/admin/setup/project-types', {
      method: isNew ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...draft, key: draft.key || draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '_') }),
    })
    const data = await res.json()
    setBusy(false)
    if (!res.ok) return toast.error(data.error ?? 'Save failed')
    toast.success(t('saved'))
    router.refresh()
    if (isNew && data.id) setSelId(data.id)
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
              {draft.id !== 'new' ? <Button variant="ghost" size="sm" disabled={busy} onClick={remove}><Trash2 size={14} /> {tCommon('actions.delete')}</Button> : null}
              <Button size="sm" disabled={busy || !draft.name.trim()} onClick={save}>{busy ? tCommon('actions.saving') : tCommon('actions.save')}</Button>
            </div>
          </div>

          {sub === 'general' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>{tCommon('labels.name')}</Label><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>{t('key')}</Label><Input value={draft.key} disabled={draft.isBuiltIn} className="font-mono" placeholder="auto" onChange={(e) => setDraft({ ...draft, key: e.target.value })} /></div>
              <div className="space-y-1.5 sm:col-span-2"><Label>{tCommon('labels.description')}</Label><Textarea value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
              <EnumField label={t('billingMethod')} value={draft.billingMethod ?? ''} options={BILLING_METHODS} onChange={(v) => setDraft({ ...draft, billingMethod: v || null })} />
              <div className="space-y-1.5"><Label>{t('sortOrder')}</Label><Input inputMode="numeric" value={String(draft.sortOrder)} onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) || 0 })} /></div>
              <EnumField label={tCommon('labels.status')} value={draft.isActive ? 'active' : 'inactive'} options={['active', 'inactive']} onChange={(v) => setDraft({ ...draft, isActive: v === 'active' })} />
            </div>
          ) : null}

          {sub === 'profitability' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <EnumField label={t('priceMethod')} value={fp.totalPrice.method} options={PRICE_METHODS} onChange={(v) => setFp({ totalPrice: { ...fp.totalPrice, method: v as any } })} />
              <EnumField label={t('cbiFormula')} value={fp.couldBeInvoiced.formula} options={CBI_FORMULAS} onChange={(v) => setFp({ couldBeInvoiced: { formula: v as any } })} />
              <EnumField label={t('costSource')} value={fp.actualCost.source} options={COST_SOURCES} onChange={(v) => setFp({ actualCost: { ...fp.actualCost, source: v as any } })} />
              {fp.actualCost.source === 'account_group' ? <EnumField label={t('costDimension')} value={fp.actualCost.dimension ?? ''} options={['', ...dimensions]} onChange={(v) => setFp({ actualCost: { ...fp.actualCost, dimension: v || undefined } })} /> : <div />}
              <EnumField label={t('laborSource')} value={fp.laborCost.source} options={LABOR_SOURCES} onChange={(v) => setFp({ laborCost: { ...fp.laborCost, source: v as any } })} />
              <EnumField label={t('burdenSource')} value={fp.burden.source} options={BURDEN_SOURCES} onChange={(v) => setFp({ burden: { ...fp.burden, source: v as any } })} />
              {fp.burden.source === 'account_group' ? <EnumField label={t('burdenDimension')} value={fp.burden.dimension ?? ''} options={['', ...dimensions]} onChange={(v) => setFp({ burden: { ...fp.burden, dimension: v || undefined } })} /> : <div />}
              <EnumField label={t('budgetSource')} value={fp.costBudget.source} options={BUDGET_SOURCES} onChange={(v) => setFp({ costBudget: { source: v as any } })} />
              <div className="sm:col-span-2"><Chips label={t('committedKinds')} all={COMMIT_KINDS} selected={fp.committedCost.docKinds} onToggle={(v) => setFp({ committedCost: { docKinds: toggle(fp.committedCost.docKinds, v) } })} /></div>
              <div className="sm:col-span-2"><Chips label={t('totalCostComponents')} all={['actual_cost', 'committed_cost', 'labor_cost', 'burden']} selected={fp.totalCost.components} onToggle={(v) => setFp({ totalCost: { components: toggle(fp.totalCost.components, v) as any } })} /></div>

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
              <div className="sm:col-span-2"><Chips label={t('allowedBases')} all={BASES} selected={ip.allowedBases} onToggle={(v) => setIp({ allowedBases: toggle(ip.allowedBases, v) })} /></div>
              <EnumField label={t('defaultBasis')} value={ip.defaultBasis} options={ip.allowedBases} onChange={(v) => setIp({ defaultBasis: v })} />
              <EnumField label={t('lineBuilder')} value={ip.lineBuilder} options={LINE_BUILDERS} onChange={(v) => setIp({ lineBuilder: v as any })} />
              <EnumField label={t('revenueAccount')} value={ip.revenueAccount} options={REVENUE_ACCTS} onChange={(v) => setIp({ revenueAccount: v as any })} />
              <EnumField label={t('recognition')} value={ip.recognition} options={RECOGNITIONS} onChange={(v) => setIp({ recognition: v as any })} />
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
