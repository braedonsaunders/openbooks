'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ChevronUp, ChevronDown, Eye, EyeOff, GripVertical, Plus, Trash2 } from 'lucide-react'
import { Button, Input, Label, UrlDrawer, cn } from '@openbooks/ui'
import {
  defaultFormLayout,
  getRecordType,
  isCustomFieldKey,
  customFieldDefKey,
  type FormLayoutConfig,
  type HeaderFieldPlacement,
  type HeaderGroup,
  type LineColumnPlacement,
} from '@openbooks/customization'

interface FormDef {
  id?: string
  name?: string
  description?: string | null
  isDefault?: boolean
  isActive?: boolean
  layout?: unknown
  recordType?: string
}

export function NewFormButton({ recordType }: { recordType: string }) {
  const t = useTranslations('customization')
  const router = useRouter()
  return (
    <Button onClick={() => router.push(`/admin/customization?recordType=${recordType}&tab=forms&form=new`)}>
      <Plus size={15} /> {t('designer.forms.new')}
    </Button>
  )
}

function nextId(prefix: string, used: Set<string>): string {
  let i = 0
  let id = `${prefix}${i}`
  while (used.has(id)) {
    i++
    id = `${prefix}${i}`
  }
  return id
}

/** Clone a layout and ensure every active custom def has a placement. */
function ensureCustomPlaced(layout: FormLayoutConfig, headerDefs: any[], lineDefs: any[]): FormLayoutConfig {
  const placedHeader = new Set<string>()
  for (const g of layout.header.groups) for (const f of g.fields) if (isCustomFieldKey(f.key)) placedHeader.add(f.key)
  const firstGroup = layout.header.groups[0]!
  for (const d of headerDefs) {
    const k = `cf_${d.key}`
    if (!placedHeader.has(k)) firstGroup.fields.push({ key: k, visible: true, required: d.isRequired ? true : null, labelOverride: null, colSpan: null })
  }
  const placedLine = new Set<string>()
  for (const c of layout.lines.columns) if (isCustomFieldKey(c.key)) placedLine.add(c.key)
  for (const d of lineDefs) {
    const k = `cf_${d.key}`
    if (!placedLine.has(k)) layout.lines.columns.push({ key: k, visible: true, width: null, labelOverride: null })
  }
  return layout
}

export function FormDesigner({
  recordType,
  def,
  headerDefs,
  lineDefs,
}: {
  recordType: string
  def: FormDef | null
  headerDefs: any[] | null
  lineDefs: any[] | null
}) {
  const t = useTranslations('customization')
  const tCommon = useTranslations('common')
  const tAp = useTranslations('ap')
  const router = useRouter()
  const creating = !def?.id
  const meta = getRecordType(recordType)
  const headerD = headerDefs ?? []
  const lineD = lineDefs ?? []

  const initial = useMemo<FormLayoutConfig>(() => {
    const base = (def?.layout as FormLayoutConfig | undefined) ?? defaultFormLayout(recordType)
    return ensureCustomPlaced(structuredClone(base), headerD, lineD)
  }, [def, recordType, headerD, lineD])

  const [name, setName] = useState(def?.name ?? '')
  const [isDefault, setIsDefault] = useState(def?.isDefault ?? false)
  const [isActive, setIsActive] = useState(def?.isActive ?? true)
  const [layout, setLayout] = useState<FormLayoutConfig>(initial)
  const [busy, setBusy] = useState(false)

  const headerDefByDefKey = useMemo(() => new Map(headerD.map((d: any) => [d.key as string, d])), [headerD])
  const lineDefByDefKey = useMemo(() => new Map(lineD.map((d: any) => [d.key as string, d])), [lineD])

  const fieldDefaultLabel = (key: string): string => {
    if (isCustomFieldKey(key)) {
      const dk = customFieldDefKey(key)
      const def = (key.startsWith('cf_') && headerDefByDefKey.has(dk) ? headerDefByDefKey : lineDefByDefKey).get(dk) as any
      return def?.label ?? key
    }
    switch (key) {
      case 'party_id': return tCommon('labels.vendor')
      case 'document_date': return tAp('drawer.dateLabel')
      case 'due_date': return tAp('drawer.dueDate')
      case 'reference_number': return tAp('drawer.reference')
      case 'memo': return tCommon('labels.memo')
      case 'account_id': return tAp('drawer.accountColumn')
      case 'description': return tCommon('labels.description')
      case 'department_id': return tCommon('labels.department')
      case 'project_id': return tCommon('labels.project')
      case 'tax_code_id': return tCommon('labels.tax')
      case 'amount': return tCommon('labels.amount')
      case 'tax_amount': return tAp('drawer.taxAmountColumn')
      default: return key
    }
  }

  const moveField = (fromGi: number, fi: number, toGi: number) =>
    setLayout((prev) => {
      const next = structuredClone(prev) as FormLayoutConfig
      const from = next.header.groups[fromGi]!.fields
      const [moved] = from.splice(fi, 1)
      if (!moved) return prev
      next.header.groups[toGi]!.fields.push(moved)
      return next
    })
  const reorder = <T,>(arr: T[], from: number, to: number): T[] => {
    if (to < 0 || to >= arr.length) return arr
    const next = [...arr]; const [m] = next.splice(from, 1); if (!m) return arr; next.splice(to, 0, m); return next
  }
  const updateField = (gi: number, fi: number, patch: Partial<HeaderFieldPlacement>) =>
    setLayout((prev) => {
      const next = structuredClone(prev) as FormLayoutConfig
      next.header.groups[gi]!.fields[fi] = { ...next.header.groups[gi]!.fields[fi]!, ...patch }
      return next
    })
  const addGroup = () =>
    setLayout((prev) => {
      const next = structuredClone(prev) as FormLayoutConfig
      const used = new Set(next.header.groups.map((g) => g.id))
      next.header.groups.push({ id: nextId('group', used), label: '', fields: [] })
      return next
    })
  const setGroupLabel = (gi: number, label: string) =>
    setLayout((prev) => {
      const next = structuredClone(prev) as FormLayoutConfig
      next.header.groups[gi]!.label = label
      return next
    })
  const removeGroup = (gi: number) =>
    setLayout((prev) => {
      if (prev.header.groups.length <= 1) return prev
      const next = structuredClone(prev) as FormLayoutConfig
      const [gone] = next.header.groups.splice(gi, 1)
      if (gone) next.header.groups[0]!.fields.push(...gone.fields)
      return next
    })
  const updateCol = (ci: number, patch: Partial<LineColumnPlacement>) =>
    setLayout((prev) => {
      const next = structuredClone(prev) as FormLayoutConfig
      next.lines.columns[ci] = { ...next.lines.columns[ci]!, ...patch }
      return next
    })

  async function save() {
    setBusy(true)
    const body = { recordType, name, layout, isDefault, isActive }
    const res = await fetch('/api/customization/form-layouts', {
      method: creating ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creating ? body : { id: def!.id, ...body }),
    })
    const data = await res.json()
    if (!res.ok) { toast.error(data.error ?? t('designer.forms.saveFailed')); setBusy(false); return }
    toast.success(t('designer.forms.saved'))
    router.push(`/admin/customization?recordType=${recordType}&tab=forms`)
    router.refresh()
  }
  async function remove() {
    if (!def?.id) return
    setBusy(true)
    const res = await fetch(`/api/customization/form-layouts/${def.id}`, { method: 'DELETE' })
    if (res.ok) { toast.success(t('designer.forms.deleted')); router.push(`/admin/customization?recordType=${recordType}&tab=forms`); router.refresh() }
    else { toast.error((await res.json()).error ?? t('designer.forms.saveFailed')); setBusy(false) }
  }

  return (
    <UrlDrawer
      open
      closeHref={`/admin/customization?recordType=${recordType}&tab=forms`}
      size="xl"
      title={creating ? t('designer.forms.newTitle') : t('designer.forms.editTitle', { name: def!.name ?? '' })}
      headerActions={
        <>
          <Button disabled={busy || !name} onClick={save}>{busy ? tCommon('actions.saving') : t('designer.forms.save')}</Button>
          {!creating ? (
            <Button variant="ghost" disabled={busy} onClick={remove} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400">
              <Trash2 size={14} /> {t('designer.forms.delete')}
            </Button>
          ) : null}
        </>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
            {t('designer.forms.isActive')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
            {t('designer.forms.isDefault')}
          </label>
        </div>
      }
    >
      <div className="space-y-6 p-1">
        <div className="space-y-1.5">
          <Label>{t('designer.forms.name')}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('designer.forms.namePlaceholder')} />
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('designer.forms.headerSection')}</h3>
            <Button variant="outline" size="sm" onClick={addGroup}><Plus size={14} /> {t('designer.forms.addGroup')}</Button>
          </div>
          {layout.header.groups.map((g: HeaderGroup, gi: number) => (
            <div key={g.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <div className="mb-2 flex items-center gap-2">
                <Input value={g.label ?? ''} onChange={(e) => setGroupLabel(gi, e.target.value)} placeholder={t('designer.forms.groupLabel')} className="h-8 flex-1" />
                {layout.header.groups.length > 1 ? (
                  <button type="button" onClick={() => removeGroup(gi)} className="text-slate-400 hover:text-red-600"><Trash2 size={15} /></button>
                ) : null}
              </div>
              <div className="space-y-1.5">
                {g.fields.map((f, fi) => (
                  <FieldRow
                    key={f.key}
                    field={f}
                    label={fieldDefaultLabel(f.key)}
                    overridable={!!meta?.headerFields.find((x) => x.key === f.key)?.requiredOverridable}
                    groups={layout.header.groups}
                    onToggleVisible={() => updateField(gi, fi, { visible: !f.visible })}
                    onToggleRequired={() => updateField(gi, fi, { required: f.required ? null : true })}
                    onLabel={(v) => updateField(gi, fi, { labelOverride: v || null })}
                    onColSpan={(v) => updateField(gi, fi, { colSpan: v ? Number(v) : null })}
                    onMoveUp={() => setLayout((p) => { const n = structuredClone(p) as FormLayoutConfig; n.header.groups[gi]!.fields = reorder(n.header.groups[gi]!.fields, fi, fi - 1); return n })}
                    onMoveDown={() => setLayout((p) => { const n = structuredClone(p) as FormLayoutConfig; n.header.groups[gi]!.fields = reorder(n.header.groups[gi]!.fields, fi, fi + 1); return n })}
                    onMoveGroup={(toGi) => moveField(gi, fi, toGi)}
                  />
                ))}
                {g.fields.length === 0 ? <p className="text-xs text-slate-400">{t('designer.forms.unlabeled')}</p> : null}
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-3">
          <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('designer.forms.linesSection')}</h3>
          <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <div className="space-y-1.5">
              {layout.lines.columns.map((c, ci) => (
                <ColumnRow
                  key={c.key}
                  col={c}
                  label={fieldDefaultLabel(c.key)}
                  onToggleVisible={() => updateCol(ci, { visible: !c.visible })}
                  onLabel={(v) => updateCol(ci, { labelOverride: v || null })}
                  onWidth={(v) => updateCol(ci, { width: v || null })}
                  onMoveUp={() => setLayout((p) => { const n = structuredClone(p) as FormLayoutConfig; n.lines.columns = reorder(n.lines.columns, ci, ci - 1); return n })}
                  onMoveDown={() => setLayout((p) => { const n = structuredClone(p) as FormLayoutConfig; n.lines.columns = reorder(n.lines.columns, ci, ci + 1); return n })}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </UrlDrawer>
  )
}

function FieldRow({
  field, label, overridable, groups, onToggleVisible, onToggleRequired, onLabel, onColSpan, onMoveUp, onMoveDown, onMoveGroup,
}: {
  field: HeaderFieldPlacement
  label: string
  overridable: boolean
  groups: HeaderGroup[]
  onToggleVisible: () => void
  onToggleRequired: () => void
  onLabel: (v: string) => void
  onColSpan: (v: string) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onMoveGroup: (toGi: number) => void
}) {
  const t = useTranslations('customization')
  const tCommon = useTranslations('common')
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 px-2.5 py-1.5 dark:border-slate-800">
      <GripVertical size={14} className="text-slate-300" />
      <span className="w-40 shrink-0 truncate text-xs font-medium text-slate-600 dark:text-slate-300">{label}</span>
      <Input value={field.labelOverride ?? ''} onChange={(e) => onLabel(e.target.value)} placeholder={label} className="h-7 w-36" />
      <select value={field.colSpan ? String(field.colSpan) : '1'} onChange={(e) => onColSpan(e.target.value)} className="h-7 rounded border border-slate-200 bg-white px-1 text-xs dark:border-slate-700 dark:bg-slate-900" aria-label={t('designer.forms.colSpan')}>
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3">3</option>
        <option value="4">4</option>
      </select>
      {groups.length > 1 ? (
        <select value="" onChange={(e) => { const v = Number(e.target.value); if (!Number.isNaN(v)) onMoveGroup(v) }} className="h-7 rounded border border-slate-200 bg-white px-1 text-xs dark:border-slate-700 dark:bg-slate-900" aria-label={t('designer.forms.moveToGroup')}>
          <option value="">{t('designer.forms.moveToGroup')}</option>
          {groups.map((g, i) => <option key={g.id} value={i}>{g.label || t('designer.forms.unlabeled')}</option>)}
        </select>
      ) : null}
      <label className="flex items-center gap-1 text-xs text-slate-500">
        <input type="checkbox" checked={!!field.required} onChange={onToggleRequired} disabled={!overridable} className="h-3.5 w-3.5 rounded border-slate-300 text-teal-600 focus:ring-teal-500 disabled:opacity-40" />
        {t('designer.forms.required')}
      </label>
      <div className="ml-auto flex items-center gap-1">
        <button type="button" onClick={onMoveUp} className="text-slate-400 hover:text-slate-600" aria-label={tCommon('actions.previous')}><ChevronUp size={15} /></button>
        <button type="button" onClick={onMoveDown} className="text-slate-400 hover:text-slate-600" aria-label={tCommon('actions.next')}><ChevronDown size={15} /></button>
        <button type="button" onClick={onToggleVisible} className={cn('text-slate-400 hover:text-slate-600', !field.visible && 'text-red-500')} aria-label={t('designer.forms.visible')}>
          {field.visible ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
      </div>
    </div>
  )
}

function ColumnRow({ col, label, onToggleVisible, onLabel, onWidth, onMoveUp, onMoveDown }: {
  col: LineColumnPlacement
  label: string
  onToggleVisible: () => void
  onLabel: (v: string) => void
  onWidth: (v: string) => void
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const t = useTranslations('customization')
  const tCommon = useTranslations('common')
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 px-2.5 py-1.5 dark:border-slate-800">
      <GripVertical size={14} className="text-slate-300" />
      <span className="w-40 shrink-0 truncate text-xs font-medium text-slate-600 dark:text-slate-300">{label}</span>
      <Input value={col.labelOverride ?? ''} onChange={(e) => onLabel(e.target.value)} placeholder={label} className="h-7 w-36" />
      <Input value={col.width ?? ''} onChange={(e) => onWidth(e.target.value)} placeholder="minmax(120px,1fr)" className="h-7 w-44 font-mono text-xs" />
      <div className="ml-auto flex items-center gap-1">
        <button type="button" onClick={onMoveUp} className="text-slate-400 hover:text-slate-600" aria-label={tCommon('actions.previous')}><ChevronUp size={15} /></button>
        <button type="button" onClick={onMoveDown} className="text-slate-400 hover:text-slate-600" aria-label={tCommon('actions.next')}><ChevronDown size={15} /></button>
        <button type="button" onClick={onToggleVisible} className={cn('text-slate-400 hover:text-slate-600', !col.visible && 'text-red-500')} aria-label={t('designer.list.visible')}>
          {col.visible ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
      </div>
    </div>
  )
}
