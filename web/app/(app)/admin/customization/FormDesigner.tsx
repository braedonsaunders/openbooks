'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ChevronDown, ChevronUp, Eye, EyeOff, GripVertical, Plus, Trash2, X } from 'lucide-react'
import { Badge, Button, Input, Label, Select, UrlDrawer, cn } from '@openbooks/ui'
import {
  customFieldDefKey,
  defaultFormLayout,
  fieldMetaFor,
  getRecordType,
  isCustomFieldKey,
  type FieldKind,
  type FieldMeta,
  type FormActionPlacement,
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

/** A custom field definition as loaded/created for the designer palette. */
interface FieldDef {
  id: string
  targetTable: string
  targetKind: string | null
  key: string
  label: string
  fieldType: string
  config: Record<string, unknown>
  isRequired: boolean
  sortOrder: number
}

/** New-form entry point — creates a blank form for the selected record type. */
export function NewFormButton({ recordType }: { recordType: string }) {
  const t = useTranslations('customization')
  const router = useRouter()
  // The transaction type is chosen by the record-type pills above the list;
  // "New form" creates a blank form for the selected type (app convention).
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

/** Turn a label into a snake_case field key that satisfies the API regex. */
function slugifyKey(label: string, used: Set<string>): string {
  let base = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  if (!base) base = 'field'
  if (!/^[a-z]/.test(base)) base = `f_${base}`
  if (base.length < 2) base = `${base}_x`
  let key = base
  let i = 1
  while (used.has(key)) {
    key = `${base}_${i}`
    i++
  }
  return key
}

/** Clone a layout and ensure every active custom def AND every built-in field
 *  has a placement. Newly registered fields are visible by default and remain
 *  user-configurable afterward. */
function ensureCustomPlaced(
  layout: FormLayoutConfig,
  headerDefs: FieldDef[],
  lineDefs: FieldDef[],
  meta: { headerFields: FieldMeta[]; lineFields: FieldMeta[] } | undefined,
): FormLayoutConfig {
  const defaultActions = defaultFormLayout(layout.recordType).actions
  const placedActions = new Set((layout.actions ?? []).map((action) => action.key))
  layout.actions = [
    ...(layout.actions ?? []),
    ...defaultActions.filter((action) => !placedActions.has(action.key)),
  ]
  const placedHeader = new Set<string>()
  for (const g of layout.header.groups) for (const f of g.fields) placedHeader.add(f.key)
  const firstGroup = layout.header.groups[0]!
  // Missing built-in header fields (registry order).
  for (const f of meta?.headerFields ?? []) {
    if (!placedHeader.has(f.key)) firstGroup.fields.push({ key: f.key, visible: true, required: f.required ? true : null, labelOverride: null, colSpan: null })
  }
  for (const d of headerDefs) {
    const k = `cf_${d.key}`
    if (!placedHeader.has(k)) firstGroup.fields.push({ key: k, visible: true, required: d.isRequired ? true : null, labelOverride: null, colSpan: null })
  }
  const placedLine = new Set<string>()
  for (const c of layout.lines.columns) placedLine.add(c.key)
  for (const f of meta?.lineFields ?? []) {
    if (!placedLine.has(f.key)) layout.lines.columns.push({ key: f.key, visible: true, width: null, labelOverride: null })
  }
  for (const d of lineDefs) {
    const k = `cf_${d.key}`
    if (!placedLine.has(k)) layout.lines.columns.push({ key: k, visible: true, width: null, labelOverride: null })
  }
  return layout
}

/** FieldKind (built-in) or custom fieldType → short kind-label i18n suffix. */
const KIND_LABEL_KEY: Record<string, string> = {
  entity_ref: 'lookup',
  reference: 'lookup',
  dimension: 'lookup',
  select: 'dropdown',
  multi_select: 'multiSelect',
  date: 'date',
  boolean: 'checkbox',
  amount: 'number',
  currency: 'number',
  number: 'number',
  tax: 'tax',
  status: 'status',
  long_text: 'textArea',
  text: 'text',
}

export function FormDesigner({
  recordType,
  def,
  headerDefs,
  lineDefs,
  duplicateFrom,
}: {
  recordType: string
  def: FormDef | null
  headerDefs: FieldDef[] | null
  lineDefs: FieldDef[] | null
  /** When creating a copy of an existing/standard form: prefilled name + layout. */
  duplicateFrom?: { name: string; layout: FormLayoutConfig } | null
}) {
  const t = useTranslations('customization')
  const tCommon = useTranslations('common')
  const tRoot = useTranslations()
  const router = useRouter()
  const creating = !def?.id
  const meta = getRecordType(recordType)
  const typeLabel = t(`recordTypes.${recordType}` as never)

  // Custom-field defs live in state so an inline-created field appears in the
  // palette immediately without a round-trip/refresh.
  const [headerD, setHeaderD] = useState<FieldDef[]>(headerDefs ?? [])
  const [lineD, setLineD] = useState<FieldDef[]>(lineDefs ?? [])

  const initial = useMemo<FormLayoutConfig>(() => {
    const base =
      duplicateFrom?.layout ??
      (def?.layout as FormLayoutConfig | undefined) ??
      defaultFormLayout(recordType)
    return ensureCustomPlaced(structuredClone(base), headerDefs ?? [], lineDefs ?? [], meta)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, recordType, duplicateFrom])

  const [name, setName] = useState(def?.name ?? duplicateFrom?.name ?? '')
  const [isDefault, setIsDefault] = useState(def?.isDefault ?? false)
  const [isActive, setIsActive] = useState(def?.isActive ?? true)
  const [layout, setLayout] = useState<FormLayoutConfig>(initial)
  const [busy, setBusy] = useState(false)

  const headerDefByDefKey = useMemo(() => new Map(headerD.map((d) => [d.key, d])), [headerD])
  const lineDefByDefKey = useMemo(() => new Map(lineD.map((d) => [d.key, d])), [lineD])

  const customDef = (key: string): FieldDef | undefined => {
    const dk = customFieldDefKey(key)
    return headerDefByDefKey.get(dk) ?? lineDefByDefKey.get(dk)
  }

  const fieldDefaultLabel = (key: string): string => {
    if (isCustomFieldKey(key)) return customDef(key)?.label ?? key
    const fm = fieldMetaFor(recordType, key)
    if (fm && tRoot.has(fm.labelKey as never)) return tRoot(fm.labelKey as never)
    return key
  }

  const fieldKind = (key: string): FieldKind | string | undefined => {
    if (isCustomFieldKey(key)) return customDef(key)?.fieldType
    return fieldMetaFor(recordType, key)?.kind
  }
  const kindBadge = (key: string): string | null => {
    const kind = fieldKind(key)
    if (!kind) return null
    return t(`designer.forms.kinds.${KIND_LABEL_KEY[kind] ?? 'text'}` as never)
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
    const next = [...arr]
    const [m] = next.splice(from, 1)
    if (!m) return arr
    next.splice(to, 0, m)
    return next
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
  const updateAction = (ai: number, patch: Partial<FormActionPlacement>) =>
    setLayout((prev) => {
      const next = structuredClone(prev) as FormLayoutConfig
      next.actions[ai] = { ...next.actions[ai]!, ...patch }
      return next
    })

  const actionLabel = (key: string) => {
    const labelKeys: Record<string, string> = {
      customize: 'common.actions.customize',
      pdf: 'common.actions.pdf',
      workflow: 'common.actions.workflowActions',
      approval: 'common.actions.approvalActions',
      edit: 'common.actions.edit',
      submit: 'common.actions.submitForApproval',
      post: 'common.actions.post',
      gl_impact: 'common.actions.glImpact',
      delete: 'common.actions.delete',
    }
    return tRoot(labelKeys[key] as never)
  }

  // Inline-create a custom field and drop it onto the form.
  const addCustomField = (def: FieldDef, level: 'header' | 'line') => {
    if (level === 'header') {
      setHeaderD((prev) => [...prev, def])
      setLayout((prev) => {
        const next = structuredClone(prev) as FormLayoutConfig
        const groups = next.header.groups
        groups[groups.length - 1]!.fields.push({ key: `cf_${def.key}`, visible: true, required: def.isRequired ? true : null, labelOverride: null, colSpan: null })
        return next
      })
    } else {
      setLineD((prev) => [...prev, def])
      setLayout((prev) => {
        const next = structuredClone(prev) as FormLayoutConfig
        next.lines.columns.push({ key: `cf_${def.key}`, visible: true, width: null, labelOverride: null })
        return next
      })
    }
  }

  async function save() {
    setBusy(true)
    const body = { recordType, name, layout, isDefault, isActive }
    const res = await fetch('/api/customization/form-layouts', {
      method: creating ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creating ? body : { id: def!.id, ...body }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('designer.forms.saveFailed'))
      setBusy(false)
      return
    }
    toast.success(t('designer.forms.saved'))
    router.push(`/admin/customization?recordType=${recordType}&tab=forms`)
    router.refresh()
  }
  async function remove() {
    if (!def?.id) return
    setBusy(true)
    const res = await fetch(`/api/customization/form-layouts/${def.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success(t('designer.forms.deleted'))
      router.push(`/admin/customization?recordType=${recordType}&tab=forms`)
      router.refresh()
    } else {
      toast.error((await res.json()).error ?? t('designer.forms.saveFailed'))
      setBusy(false)
    }
  }

  const usedFieldKeys = useMemo(() => {
    const s = new Set<string>()
    for (const g of layout.header.groups) for (const f of g.fields) s.add(f.key)
    for (const c of layout.lines.columns) s.add(c.key)
    return s
  }, [layout])

  return (
    <UrlDrawer
      open
      closeHref={`/admin/customization?recordType=${recordType}&tab=forms`}
      size="xl"
      title={creating ? t('designer.forms.newTitleFor', { type: typeLabel }) : t('designer.forms.editTitle', { name: def!.name ?? '' })}
      headerActions={
        <>
          <Button disabled={busy || !name} onClick={save}>
            {busy ? tCommon('actions.saving') : t('designer.forms.save')}
          </Button>
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
          <p className="text-xs text-slate-400">{t('designer.forms.basedOn', { type: typeLabel })}</p>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('designer.forms.headerSection')}</h3>
            <Button variant="outline" size="sm" onClick={addGroup}>
              <Plus size={14} /> {t('designer.forms.addGroup')}
            </Button>
          </div>
          {layout.header.groups.map((g: HeaderGroup, gi: number) => (
            <div key={g.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <div className="mb-2 flex items-center gap-2">
                <Input value={g.label ?? ''} onChange={(e) => setGroupLabel(gi, e.target.value)} placeholder={t('designer.forms.groupLabel')} className="h-8 flex-1" />
                {layout.header.groups.length > 1 ? (
                  <button type="button" onClick={() => removeGroup(gi)} className="text-slate-400 hover:text-red-600">
                    <Trash2 size={15} />
                  </button>
                ) : null}
              </div>
              <div className="space-y-2">
                {g.fields.map((f, fi) => (
                  <FieldRow
                    key={f.key}
                    field={f}
                    label={fieldDefaultLabel(f.key)}
                    kindLabel={kindBadge(f.key)}
                    overridable={!!meta?.headerFields.find((x) => x.key === f.key)?.requiredOverridable}
                    locked={!!meta?.headerFields.find((x) => x.key === f.key)?.locked}
                    groups={layout.header.groups}
                    groupIndex={gi}
                    onToggleVisible={() => updateField(gi, fi, { visible: !f.visible })}
                    onToggleRequired={() => updateField(gi, fi, { required: f.required ? null : true })}
                    onLabel={(v) => updateField(gi, fi, { labelOverride: v || null })}
                    onColSpan={(v) => updateField(gi, fi, { colSpan: v ? Number(v) : null })}
                    onMoveUp={() => setLayout((p) => { const n = structuredClone(p) as FormLayoutConfig; n.header.groups[gi]!.fields = reorder(n.header.groups[gi]!.fields, fi, fi - 1); return n })}
                    onMoveDown={() => setLayout((p) => { const n = structuredClone(p) as FormLayoutConfig; n.header.groups[gi]!.fields = reorder(n.header.groups[gi]!.fields, fi, fi + 1); return n })}
                    onMoveGroup={(toGi) => moveField(gi, fi, toGi)}
                  />
                ))}
                {g.fields.length === 0 ? <p className="text-xs text-slate-400">{t('designer.forms.emptyGroup')}</p> : null}
              </div>
            </div>
          ))}
          <AddFieldPanel level="header" recordType={recordType} usedKeys={usedFieldKeys} onCreated={(d) => addCustomField(d, 'header')} />
        </div>

        <div className="space-y-3">
          <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('designer.forms.linesSection')}</h3>
          <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <div className="space-y-2">
              {layout.lines.columns.map((c, ci) => (
                <ColumnRow
                  key={c.key}
                  col={c}
                  label={fieldDefaultLabel(c.key)}
                  kindLabel={kindBadge(c.key)}
                  locked={!!meta?.lineFields.find((x) => x.key === c.key)?.locked}
                  onToggleVisible={() => updateCol(ci, { visible: !c.visible })}
                  onLabel={(v) => updateCol(ci, { labelOverride: v || null })}
                  onWidth={(v) => updateCol(ci, { width: v || null })}
                  onMoveUp={() => setLayout((p) => { const n = structuredClone(p) as FormLayoutConfig; n.lines.columns = reorder(n.lines.columns, ci, ci - 1); return n })}
                  onMoveDown={() => setLayout((p) => { const n = structuredClone(p) as FormLayoutConfig; n.lines.columns = reorder(n.lines.columns, ci, ci + 1); return n })}
                />
              ))}
            </div>
          </div>
          <AddFieldPanel level="line" recordType={recordType} usedKeys={usedFieldKeys} onCreated={(d) => addCustomField(d, 'line')} />
        </div>

        <div className="space-y-3">
          <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('designer.forms.actionsSection')}</h3>
          <p className="text-xs text-slate-400">{t('designer.forms.actionsHelp')}</p>
          <div className="space-y-1.5 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            {layout.actions.map((action, ai) => (
              <div key={action.key} className="flex items-center gap-2 rounded-md border border-slate-100 px-2.5 py-1.5 dark:border-slate-800">
                <GripVertical size={14} className="text-slate-300" />
                <span className="flex-1 text-xs font-medium text-slate-600 dark:text-slate-300">{actionLabel(action.key)}</span>
                <button type="button" onClick={() => setLayout((p) => { const n = structuredClone(p) as FormLayoutConfig; n.actions = reorder(n.actions, ai, ai - 1); return n })} className="text-slate-400 hover:text-slate-600" aria-label={tCommon('actions.previous')}><ChevronUp size={15} /></button>
                <button type="button" onClick={() => setLayout((p) => { const n = structuredClone(p) as FormLayoutConfig; n.actions = reorder(n.actions, ai, ai + 1); return n })} className="text-slate-400 hover:text-slate-600" aria-label={tCommon('actions.next')}><ChevronDown size={15} /></button>
                <button type="button" onClick={() => updateAction(ai, { visible: !action.visible })} className={action.visible ? 'text-slate-400 hover:text-slate-600' : 'text-red-500'} aria-label={t('designer.forms.visible')}>
                  {action.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </UrlDrawer>
  )
}

/** Small "Card / Date / Lookup…" chip clarifying the control a field renders. */
function KindChip({ label }: { label: string | null }) {
  if (!label) return null
  return (
    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-slate-500 uppercase dark:bg-slate-800 dark:text-slate-400">
      {label}
    </span>
  )
}

function FieldRow({
  field, label, kindLabel, overridable, locked, groups, groupIndex, onToggleVisible, onToggleRequired, onLabel, onColSpan, onMoveUp, onMoveDown, onMoveGroup,
}: {
  field: HeaderFieldPlacement
  label: string
  kindLabel: string | null
  overridable: boolean
  locked: boolean
  groups: HeaderGroup[]
  groupIndex: number
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
    <div className={cn('space-y-2 rounded-md border border-slate-100 px-3 py-2 dark:border-slate-800', !field.visible && 'opacity-60')}>
      <div className="flex items-center gap-2">
        <GripVertical size={14} className="shrink-0 text-slate-300" />
        <span className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">{label}</span>
        <KindChip label={kindLabel} />
        {locked ? <Badge variant="outline">{t('designer.forms.locked')}</Badge> : null}
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={onMoveUp} className="text-slate-400 hover:text-slate-600" aria-label={tCommon('actions.previous')}><ChevronUp size={16} /></button>
          <button type="button" onClick={onMoveDown} className="text-slate-400 hover:text-slate-600" aria-label={tCommon('actions.next')}><ChevronDown size={16} /></button>
          <button type="button" onClick={onToggleVisible} className={cn('text-slate-400 hover:text-slate-600', !field.visible && 'text-red-500')} aria-label={t('designer.forms.visible')}>
            {field.visible ? <Eye size={16} /> : <EyeOff size={16} />}
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-6">
        <Input value={field.labelOverride ?? ''} onChange={(e) => onLabel(e.target.value)} placeholder={t('designer.forms.renamePlaceholder', { label })} className="h-8 w-44" />
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-400">{t('designer.forms.colSpan')}</span>
          <Select value={field.colSpan ? String(field.colSpan) : '1'} onChange={(e) => onColSpan(e.target.value)} triggerClassName="h-8 w-20" aria-label={t('designer.forms.colSpan')}>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
          </Select>
        </div>
        {groups.length > 1 ? (
          <Select
            value={String(groupIndex)}
            triggerClassName="h-8 w-40"
            onChange={(e) => { const v = Number(e.target.value); if (!Number.isNaN(v) && v !== groupIndex) onMoveGroup(v) }}
            aria-label={t('designer.forms.moveToGroup')}
          >
            {groups.map((g, i) => (
              <option key={g.id} value={i}>
                {g.label || t('designer.forms.unlabeled')}
              </option>
            ))}
          </Select>
        ) : null}
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          <input type="checkbox" checked={!!field.required} onChange={onToggleRequired} disabled={!overridable} className="h-3.5 w-3.5 rounded border-slate-300 text-teal-600 focus:ring-teal-500 disabled:opacity-40" />
          {t('designer.forms.required')}
        </label>
      </div>
    </div>
  )
}

function ColumnRow({ col, label, kindLabel, locked, onToggleVisible, onLabel, onWidth, onMoveUp, onMoveDown }: {
  col: LineColumnPlacement
  label: string
  kindLabel: string | null
  locked: boolean
  onToggleVisible: () => void
  onLabel: (v: string) => void
  onWidth: (v: string) => void
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const t = useTranslations('customization')
  const tCommon = useTranslations('common')
  return (
    <div className={cn('space-y-2 rounded-md border border-slate-100 px-3 py-2 dark:border-slate-800', !col.visible && 'opacity-60')}>
      <div className="flex items-center gap-2">
        <GripVertical size={14} className="shrink-0 text-slate-300" />
        <span className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">{label}</span>
        <KindChip label={kindLabel} />
        {locked ? <Badge variant="outline">{t('designer.forms.locked')}</Badge> : null}
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={onMoveUp} className="text-slate-400 hover:text-slate-600" aria-label={tCommon('actions.previous')}><ChevronUp size={16} /></button>
          <button type="button" onClick={onMoveDown} className="text-slate-400 hover:text-slate-600" aria-label={tCommon('actions.next')}><ChevronDown size={16} /></button>
          <button type="button" onClick={onToggleVisible} className={cn('text-slate-400 hover:text-slate-600', !col.visible && 'text-red-500')} aria-label={t('designer.list.visible')}>
            {col.visible ? <Eye size={16} /> : <EyeOff size={16} />}
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-6">
        <Input value={col.labelOverride ?? ''} onChange={(e) => onLabel(e.target.value)} placeholder={t('designer.forms.renamePlaceholder', { label })} className="h-8 w-44" />
        <Input value={col.width ?? ''} onChange={(e) => onWidth(e.target.value)} placeholder="minmax(120px,1fr)" className="h-8 w-44 font-mono text-xs" aria-label={t('designer.forms.width')} />
      </div>
    </div>
  )
}

// Field types offered by the inline creator — the subset the custom-field API
// accepts (labels reuse the admin.customFields catalog).
const INLINE_FIELD_TYPES = ['text', 'long_text', 'number', 'currency', 'date', 'boolean', 'select', 'multi_select'] as const

/** Inline "Add field" — creates a custom field def and places it on the form. */
function AddFieldPanel({ level, recordType, usedKeys, onCreated }: {
  level: 'header' | 'line'
  recordType: string
  usedKeys: Set<string>
  onCreated: (def: FieldDef) => void
}) {
  const t = useTranslations('customization')
  const tCommon = useTranslations('common')
  const tTypes = useTranslations('admin.customFields')
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [fieldType, setFieldType] = useState<string>('text')
  const [options, setOptions] = useState('')
  const [busy, setBusy] = useState(false)

  const needsOptions = fieldType === 'select' || fieldType === 'multi_select'

  const reset = () => {
    setLabel('')
    setFieldType('text')
    setOptions('')
    setOpen(false)
  }

  async function create() {
    const trimmed = label.trim()
    if (!trimmed) return
    const opts = options.split(/[\n,]/).map((o) => o.trim()).filter(Boolean)
    if (needsOptions && opts.length === 0) {
      toast.error(t('designer.forms.optionsRequired'))
      return
    }
    setBusy(true)
    const usedDefKeys = new Set(Array.from(usedKeys).filter((k) => k.startsWith('cf_')).map((k) => k.slice(3)))
    const key = slugifyKey(trimmed, usedDefKeys)
    const config = needsOptions ? { options: opts } : {}
    const targetTable = level === 'header' ? 'documents' : 'document_lines'
    const res = await fetch('/api/admin/custom-fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetTable, targetKind: recordType, key, label: trimmed, fieldType, config, isRequired: false, sortOrder: 0 }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(data.error ?? t('designer.forms.addFieldFailed'))
      setBusy(false)
      return
    }
    onCreated({ id: data.id, targetTable, targetKind: recordType, key, label: trimmed, fieldType, config, isRequired: false, sortOrder: 0 })
    toast.success(t('designer.forms.addFieldDone', { label: trimmed }))
    setBusy(false)
    reset()
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus size={14} /> {t('designer.forms.addField')}
      </Button>
    )
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-teal-300 bg-teal-50/40 p-3 dark:border-teal-800 dark:bg-teal-950/20">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold tracking-wide text-teal-700 uppercase dark:text-teal-300">{t('designer.forms.newFieldTitle')}</span>
        <button type="button" onClick={reset} className="text-slate-400 hover:text-slate-600" aria-label={tCommon('actions.cancel')}><X size={15} /></button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>{t('designer.forms.fieldLabel')}</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('designer.forms.fieldLabelPlaceholder')} autoFocus />
        </div>
        <div className="space-y-1">
          <Label>{t('designer.forms.fieldType')}</Label>
          <Select value={fieldType} onChange={(e) => setFieldType(e.target.value)} triggerClassName="h-9">
            {INLINE_FIELD_TYPES.map((ft) => (
              <option key={ft} value={ft}>
                {tTypes(`types.${ft === 'long_text' ? 'longText' : ft === 'multi_select' ? 'multiSelect' : ft}.label` as never)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {needsOptions ? (
        <div className="space-y-1">
          <Label>{t('designer.forms.fieldOptions')}</Label>
          <Input value={options} onChange={(e) => setOptions(e.target.value)} placeholder={t('designer.forms.fieldOptionsPlaceholder')} />
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>{tCommon('actions.cancel')}</Button>
        <Button size="sm" onClick={create} disabled={busy || !label.trim()}>
          {busy ? tCommon('actions.saving') : t('designer.forms.addFieldConfirm')}
        </Button>
      </div>
    </div>
  )
}
