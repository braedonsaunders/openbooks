'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ChevronUp, ChevronDown, Eye, EyeOff, GripVertical, Plus, Trash2 } from 'lucide-react'
import { Button, Input, Label, Select, UrlDrawer, cn } from '@openbooks/ui'
import {
  defaultListView,
  getRecordType,
  isCustomFieldKey,
  customFieldDefKey,
  recordTypeForFeatureState,
  type FilterClause,
  type FilterOperator,
  type ListViewConfig,
  type ListColumnPlacement,
  OPERATORS_BY_KIND,
} from '@openbooks/customization'
import type { CustomFieldDefClient } from '../../../../components/custom-field-inputs'

interface ViewDef {
  id?: string
  name?: string
  scope?: 'org' | 'user'
  isDefault?: boolean
  isActive?: boolean
  config?: unknown
  recordType?: string
}

export function NewViewButton({ recordType }: { recordType: string }) {
  const t = useTranslations('customization')
  const router = useRouter()
  return (
    <Button onClick={() => router.push(`/admin/customization?recordType=${recordType}&tab=views&view=new`)}>
      <Plus size={15} /> {t('designer.list.new')}
    </Button>
  )
}

function ensureCustomColumns(view: ListViewConfig, showInListDefs: CustomFieldDefClient[]): ListViewConfig {
  const placed = new Set(view.columns.map((c) => c.key))
  for (const column of getRecordType(view.recordType)?.listColumns ?? []) {
    if (!placed.has(column.key)) {
      view.columns.push({ key: column.key, visible: true, width: column.defaultWidth ?? null, labelOverride: null })
      placed.add(column.key)
    }
  }
  for (const d of showInListDefs) {
    const k = `cf_${d.key}`
    if (!placed.has(k)) view.columns.push({ key: k, visible: true, width: null, labelOverride: null })
  }
  return view
}

export function ListViewDesigner({
  recordType,
  def,
  canManageOrg,
  userId,
  showInListDefs,
  filterOptions,
  inventoryEnabled,
  crmEnabled,
}: {
  recordType: string
  def: ViewDef | null
  canManageOrg: boolean
  userId: string
  showInListDefs: CustomFieldDefClient[]
  filterOptions: Record<string, { value: string; label: string }[]>
  inventoryEnabled: boolean
  crmEnabled: boolean
}) {
  const t = useTranslations('customization')
  const tCommon = useTranslations('common')
  const tRoot = useTranslations()
  const router = useRouter()
  const creating = !def?.id
  const catalog = getRecordType(recordType)
  const meta = catalog
    ? recordTypeForFeatureState(catalog, { inventory: inventoryEnabled, crm: crmEnabled })
    : catalog

  const initial = useMemo<ListViewConfig>(() => {
    const base = (def?.config as ListViewConfig | undefined) ?? defaultListView(recordType)
    return ensureCustomColumns(structuredClone(base), showInListDefs)
  }, [def, recordType, showInListDefs])

  const [name, setName] = useState(def?.name ?? '')
  const [scope, setScope] = useState<'org' | 'user'>(def?.scope === 'org' ? 'org' : 'user')
  const [isDefault, setIsDefault] = useState(def?.isDefault ?? false)
  const [isActive, setIsActive] = useState(def?.isActive ?? true)
  const [view, setView] = useState<ListViewConfig>(initial)
  const [busy, setBusy] = useState(false)

  const showInListByDefKey = useMemo(() => new Map(showInListDefs.map((d) => [d.key, d])), [showInListDefs])

  const colLabel = (key: string): string => {
    if (isCustomFieldKey(key)) return showInListByDefKey.get(customFieldDefKey(key))?.label ?? key
    const column = meta?.listColumns.find((candidate) => candidate.key === key)
    if (column && tRoot.has(column.labelKey as never)) return tRoot(column.labelKey as never)
    switch (key) {
      case 'document_number': return tCommon('labels.number')
      case 'party_name': return recordType.startsWith('customer') ? tCommon('labels.customer') : tCommon('labels.vendor')
      case 'document_date': return tCommon('labels.date')
      case 'bank_account': return tCommon('labels.account')
      case 'reference_number': return tCommon('labels.reference')
      case 'total': return tCommon('labels.total')
      case 'status': return tCommon('labels.status')
      case '_actions': return tCommon('labels.actions')
      default: return key
    }
  }

  const updateCol = (ci: number, patch: Partial<ListColumnPlacement>) =>
    setView((p) => { const n = structuredClone(p) as ListViewConfig; n.columns[ci] = { ...n.columns[ci]!, ...patch }; return n })
  const reorder = <T,>(arr: T[], from: number, to: number): T[] => {
    if (to < 0 || to >= arr.length) return arr
    const next = [...arr]; const [m] = next.splice(from, 1); if (!m) return arr; next.splice(to, 0, m); return next
  }

  // filters
  const addFilter = () =>
    setView((p) => {
      const n = structuredClone(p) as ListViewConfig
      const first = meta?.listFilters[0]
      n.filters.push({ key: first?.key ?? 'status', operator: first?.operators[0] ?? 'eq', value: '', to: null })
      return n
    })
  const updateFilter = (fi: number, patch: Partial<FilterClause>) =>
    setView((p) => { const n = structuredClone(p) as ListViewConfig; n.filters[fi] = { ...n.filters[fi]!, ...patch }; return n })
  const removeFilter = (fi: number) =>
    setView((p) => { const n = structuredClone(p) as ListViewConfig; n.filters.splice(fi, 1); return n })

  const filterMeta = (key: string) => meta?.listFilters.find((f) => f.key === key)
  const sortableCols = meta?.listColumns.filter((c) => c.sortable) ?? []

  async function save() {
    setBusy(true)
    const body = { recordType, name, scope, config: view, isDefault, isActive }
    const res = await fetch(creating ? '/api/customization/list-views' : `/api/customization/list-views/${def!.id}`, {
      method: creating ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) { toast.error(data.error ?? t('designer.list.saveFailed')); setBusy(false); return }
    toast.success(t('designer.list.saved'))
    router.push(`/admin/customization?recordType=${recordType}&tab=views`)
    router.refresh()
  }
  async function remove() {
    if (!def?.id) return
    setBusy(true)
    const res = await fetch(`/api/customization/list-views/${def.id}`, { method: 'DELETE' })
    if (res.ok) { toast.success(t('designer.list.deleted')); router.push(`/admin/customization?recordType=${recordType}&tab=views`); router.refresh() }
    else { toast.error((await res.json()).error ?? t('designer.list.saveFailed')); setBusy(false) }
  }

  const canSetOrgDefault = scope === 'org' ? canManageOrg : true

  return (
    <UrlDrawer
      open
      closeHref={`/admin/customization?recordType=${recordType}&tab=views`}
      size="xl"
      title={creating ? t('designer.list.newTitle') : t('designer.list.editTitle', { name: def!.name ?? '' })}
      headerActions={
        <>
          <Button disabled={busy || !name} onClick={save}>{busy ? tCommon('actions.saving') : t('designer.list.save')}</Button>
          {!creating ? <Button variant="ghost" disabled={busy} onClick={remove} className="text-red-600 hover:bg-red-50 dark:text-red-400"><Trash2 size={14} /> {t('designer.list.delete')}</Button> : null}
        </>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
            {t('designer.list.isActive')}
          </label>
          {canSetOrgDefault ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
              {t('designer.list.isDefault')}
            </label>
          ) : null}
        </div>
      }
    >
      <div className="space-y-6 p-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t('designer.list.name')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('designer.list.newTitle')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('designer.list.scope')}</Label>
            <Select
              value={scope}
              onChange={(e) => setScope(e.target.value as 'org' | 'user')}
              disabled={!canManageOrg || !creating}
            >
              <option value="user">{t('designer.list.scopeUser')}</option>
              <option value="org" disabled={!canManageOrg}>{t('designer.list.scopeOrg')}</option>
            </Select>
          </div>
        </div>

        {/* Columns */}
        <div className="space-y-3">
          <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('designer.list.columnsSection')}</h3>
          <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <div className="space-y-1.5">
              {view.columns.map((c, ci) => (
                <div key={c.key} className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 px-2.5 py-1.5 dark:border-slate-800">
                  <GripVertical size={14} className="text-slate-300" />
                  <span className="w-44 shrink-0 truncate text-xs font-medium text-slate-600 dark:text-slate-300">{colLabel(c.key)}</span>
                  <Input value={c.labelOverride ?? ''} onChange={(e) => updateCol(ci, { labelOverride: e.target.value || null })} placeholder={colLabel(c.key)} className="h-7 w-36" />
                  <div className="ml-auto flex items-center gap-1">
                    <button type="button" onClick={() => setView((p) => { const n = structuredClone(p) as ListViewConfig; n.columns = reorder(n.columns, ci, ci - 1); return n })} className="text-slate-400 hover:text-slate-600"><ChevronUp size={15} /></button>
                    <button type="button" onClick={() => setView((p) => { const n = structuredClone(p) as ListViewConfig; n.columns = reorder(n.columns, ci, ci + 1); return n })} className="text-slate-400 hover:text-slate-600"><ChevronDown size={15} /></button>
                    <button type="button" onClick={() => updateCol(ci, { visible: !c.visible })} className={cn('text-slate-400 hover:text-slate-600', !c.visible && 'text-red-500')} aria-label={t('designer.list.visible')}>
                      {c.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('designer.list.filtersSection')}</h3>
            <Button variant="outline" size="sm" onClick={addFilter}><Plus size={14} /> {t('designer.list.addFilter')}</Button>
          </div>
          {view.filters.length === 0 ? <p className="text-xs text-slate-400">{t('designer.list.noFilters')}</p> : null}
          <div className="space-y-1.5">
            {view.filters.map((f, fi) => {
              const fm = filterMeta(f.key)
              const ops = fm?.operators ?? (OPERATORS_BY_KIND.text as readonly FilterOperator[])
              const valueKind = fm?.kind ?? 'text'
              return (
                <div key={fi} className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 px-2.5 py-1.5 dark:border-slate-800">
                  <Select value={f.key} onChange={(e) => { const nm = filterMeta(e.target.value); updateFilter(fi, { key: e.target.value, operator: nm?.operators[0] ?? 'eq', value: '', to: null }) }} className="h-7 w-40">
                    {meta?.listFilters.map((lf) => <option key={lf.key} value={lf.key}>{tRoot.has(lf.labelKey as never) ? tRoot(lf.labelKey as never) : lf.key}</option>)}
                  </Select>
                  <Select value={f.operator} onChange={(e) => updateFilter(fi, { operator: e.target.value as FilterOperator })} className="h-7 w-32">
                    {ops.map((o) => <option key={o} value={o}>{o}</option>)}
                  </Select>
                  {f.operator !== 'is_set' && f.operator !== 'is_not_set' ? (
                    valueKind === 'boolean' ? (
                      <Select value={Array.isArray(f.value) ? f.value[0] : (f.value as string) ?? ''} onChange={(e) => updateFilter(fi, { value: e.target.value })} className="h-7 w-28">
                        <option value="true">{tCommon('labels.yes')}</option>
                        <option value="false">{tCommon('labels.no')}</option>
                      </Select>
                    ) : valueKind === 'select' && fm?.options ? (
                      <Select value={Array.isArray(f.value) ? f.value[0] : (f.value as string) ?? ''} onChange={(e) => updateFilter(fi, { value: e.target.value })} className="h-7 w-40">
                        <option value="">—</option>
                        {fm.options.map((o) => <option key={o.value} value={o.value}>{o.labelKey && tRoot.has(o.labelKey as never) ? tRoot(o.labelKey as never) : o.value}</option>)}
                      </Select>
                    ) : valueKind === 'entity_ref' && filterOptions[f.key]?.length ? (
                      <Select value={Array.isArray(f.value) ? f.value[0] : (f.value as string) ?? ''} onChange={(e) => updateFilter(fi, { value: e.target.value })} className="h-7 w-52">
                        <option value="">—</option>
                        {filterOptions[f.key]!.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </Select>
                    ) : (
                      <Input value={Array.isArray(f.value) ? f.value.join(',') : (f.value as string) ?? ''} onChange={(e) => updateFilter(fi, { value: e.target.value })} className="h-7 w-40" />
                    )
                  ) : null}
                  {f.operator === 'between' ? (
                    <Input value={f.to ?? ''} onChange={(e) => updateFilter(fi, { to: e.target.value })} placeholder={t('designer.list.filterTo')} className="h-7 w-40" />
                  ) : null}
                  <button type="button" onClick={() => removeFilter(fi)} className="ml-auto text-slate-400 hover:text-red-600" aria-label={t('designer.list.removeFilter')}><Trash2 size={14} /></button>
                </div>
              )
            })}
          </div>
        </div>

        {/* Sort + perPage */}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>{t('designer.list.sortColumn')}</Label>
            <Select value={view.sort?.column ?? ''} onChange={(e) => setView((p) => { const n = structuredClone(p) as ListViewConfig; n.sort = e.target.value ? { column: e.target.value, dir: n.sort?.dir ?? 'desc' } : null; return n })}>
              <option value="">{tCommon('labels.none')}</option>
              {sortableCols.map((c) => <option key={c.key} value={c.key}>{colLabel(c.key)}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('designer.list.sortDir')}</Label>
            <Select value={view.sort?.dir ?? 'desc'} onChange={(e) => setView((p) => { const n = structuredClone(p) as ListViewConfig; if (n.sort) n.sort.dir = e.target.value as 'asc' | 'desc'; return n })}>
              <option value="asc">{t('designer.list.asc')}</option>
              <option value="desc">{t('designer.list.desc')}</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('designer.list.perPage')}</Label>
            <Input type="number" min={5} max={100} value={view.perPage ?? 25} onChange={(e) => setView((p) => { const n = structuredClone(p) as ListViewConfig; n.perPage = Number(e.target.value) || 25; return n })} />
          </div>
        </div>
      </div>
    </UrlDrawer>
  )
}
