'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, ChevronDown, ExternalLink, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  type FieldType,
  type FormField,
  type FormulaExpression,
} from '@openbooks/forms-core'
import {
  Badge,
  Button,
  Input,
  Label,
  Popover,
  SearchSelect,
  Textarea,
  UrlDrawer,
  cn,
} from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'
import { ICON_KEYS, NavIcon } from '../../../../components/sidebar-nav'
import {
  RECORD_FIELD_TYPES,
  describeIssue,
  slugifyFieldId,
  slugifyTypeKey,
} from '../../../../lib/record-schema'

export type RecordTypePayload = {
  id: string
  key: string
  name: string
  pluralName: string
  iconKey: string
  description: string | null
  fields: unknown
  status: 'draft' | 'published' | 'archived'
  showInNav: boolean
  allowedRoles: string[] | null
  sortOrder: number
}

type Issue = { path: Array<string | number>; message: string }

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'outline'> = {
  published: 'success',
  draft: 'secondary',
  archived: 'outline',
}

const field = 'space-y-1.5'

/**
 * The record-type builder flyout — create (instant draft), edit (autosave),
 * publish/archive. Field definitions use the forms-core field model; the
 * server lints on every save and publishing requires a clean definition.
 * Published types stay editable (changes go live immediately); only the key
 * is pinned after publish.
 */
export function TypeBuilderDrawer({
  type,
  roles,
}: {
  type: RecordTypePayload
  roles: { key: string; name: string }[]
}) {
  const router = useRouter()
  const t = useTranslations('records')
  const tc = useTranslations('common')
  const isDraft = type.status === 'draft'

  const [name, setName] = useState(type.name)
  const [pluralName, setPluralName] = useState(type.pluralName)
  const [key, setKey] = useState(type.key)
  const [keyTouched, setKeyTouched] = useState(!isDraft || type.key !== slugifyTypeKey(type.name))
  const [pluralTouched, setPluralTouched] = useState(type.pluralName !== `${type.name}s`)
  const [iconKey, setIconKey] = useState(type.iconKey)
  const [description, setDescription] = useState(type.description ?? '')
  const [showInNav, setShowInNav] = useState(type.showInNav)
  const [sortOrder, setSortOrder] = useState(type.sortOrder)
  const [allowedRoles, setAllowedRoles] = useState<string[]>(type.allowedRoles ?? [])
  const [fields, setFields] = useState<FormField[]>(
    Array.isArray(type.fields) ? (type.fields as FormField[]) : [],
  )
  const [expanded, setExpanded] = useState<string | null>(null)
  const [issues, setIssues] = useState<Issue[]>([])
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty'>('saved')
  const [busy, setBusy] = useState(false)

  function rename(nextName: string) {
    setName(nextName)
    if (isDraft && !keyTouched) setKey(slugifyTypeKey(nextName))
    if (!pluralTouched) setPluralName(nextName ? `${nextName}s` : '')
  }

  // -- autosave ---------------------------------------------------------------
  const payload = useMemo(
    () => ({
      name,
      pluralName,
      ...(isDraft ? { key } : {}),
      iconKey,
      description: description || null,
      showInNav,
      sortOrder,
      allowedRoles: allowedRoles.length > 0 ? allowedRoles : null,
      fields,
    }),
    [name, pluralName, key, iconKey, description, showInNav, sortOrder, allowedRoles, fields, isDraft],
  )
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    setSaveState('dirty')
    const timer = setTimeout(async () => {
      setSaveState('saving')
      const res = await fetch(`/api/records/types/${type.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (res.ok) {
        setIssues(data.issues ?? [])
        setSaveState('saved')
        router.refresh()
      } else {
        setSaveState('dirty')
        toast.error(data.error ?? t('typeBuilder.autosaveFailed'))
      }
    }, 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload])

  // -- field operations ---------------------------------------------------------
  function uniqueFieldId(base: string): string {
    const taken = new Set(fields.map((f) => f.id))
    let id = base || 'field'
    for (let n = 2; taken.has(id); n++) id = `${base || 'field'}_${n}`
    return id
  }

  function addField(fieldType: FieldType) {
    const label = t(`fieldTypes.${fieldType}.label`)
    const next: FormField = {
      id: uniqueFieldId(slugifyFieldId(label)),
      type: fieldType,
      label,
      ...(fieldType === 'select' || fieldType === 'multi_select' || fieldType === 'radio'
        ? { validation: { options: [{ value: 'option_1', label: t('typeBuilder.optionPlaceholder', { n: 1 }) }] } }
        : {}),
      ...(fieldType === 'formula'
        ? { formula: { kind: 'sum', of: [] } as FormulaExpression, config: { format: 'number' } }
        : {}),
    }
    setFields((fs) => [...fs, next])
    setExpanded(next.id)
  }

  const updateField = (id: string, patch: Partial<FormField>) =>
    setFields((fs) => fs.map((f) => (f.id === id ? ({ ...f, ...patch } as FormField) : f)))

  const moveField = (index: number, dir: -1 | 1) =>
    setFields((fs) => {
      const j = index + dir
      if (j < 0 || j >= fs.length) return fs
      const next = [...fs]
      const [f] = next.splice(index, 1)
      next.splice(j, 0, f!)
      return next
    })

  async function removeField(f: FormField) {
    const ok = await confirmDialog({
      message: t('typeBuilder.removeFieldConfirm', { label: f.label }),
      tone: 'danger',
    })
    if (ok) setFields((fs) => fs.filter((x) => x.id !== f.id))
  }

  // -- lifecycle actions ----------------------------------------------------------
  async function lifecycle(action: 'publish' | 'archive') {
    if (action === 'archive') {
      const ok = await confirmDialog({
        message: t('typeBuilder.archiveConfirm', { name }),
        tone: 'danger',
      })
      if (!ok) return
    }
    setBusy(true)
    const res = await fetch(`/api/records/types/${type.id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('typeBuilder.actionFailed'))
      if (data.issues) setIssues(data.issues)
    } else {
      toast.success(
        action === 'publish'
          ? t('typeBuilder.publishedToast', { name, key })
          : t('typeBuilder.archivedToast'),
      )
    }
    setBusy(false)
    router.refresh()
  }

  async function destroy() {
    const ok = await confirmDialog({
      message: t('typeBuilder.deleteConfirm', { name }),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    const res = await fetch(`/api/records/types/${type.id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? tc('feedback.deleteFailed'))
      setBusy(false)
      return
    }
    toast.success(t('typeBuilder.draftDeleted'))
    router.push('/records/types')
    router.refresh()
  }

  const canPublish = saveState === 'saved' && !busy && fields.length > 0 && issues.length === 0

  return (
    <UrlDrawer
      open
      closeHref="/records/types"
      size="xl"
      title={
        <span className="flex items-center gap-2.5">
          <NavIcon iconKey={iconKey} size={16} className="text-slate-500 dark:text-slate-400" />
          <span>{name || t('typeBuilder.fallbackTitle')}</span>
          <Badge variant={STATUS_VARIANT[type.status] ?? 'secondary'}>
            {t(`typeStatus.${type.status}`)}
          </Badge>
        </span>
      }
      description={
        isDraft
          ? t('typeBuilder.descriptionDraft')
          : type.status === 'published'
            ? t('typeBuilder.descriptionPublished')
            : t('typeBuilder.descriptionArchived')
      }
      headerActions={
        <>
          {isDraft ? (
            <Button variant="ghost" disabled={busy} onClick={destroy}>
              <Trash2 size={14} /> {t('typeBuilder.deleteDraft')}
            </Button>
          ) : null}
          {type.status === 'published' ? (
            <>
              <Button variant="outline" asChild>
                <Link href={`/records/${key}` as any}>
                  <ExternalLink size={14} /> {t('typeBuilder.openModule')}
                </Link>
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => lifecycle('archive')}>
                {t('typeBuilder.archive')}
              </Button>
            </>
          ) : (
            <Button disabled={!canPublish} onClick={() => lifecycle('publish')}>
              {type.status === 'archived' ? t('typeBuilder.publishAgain') : t('typeBuilder.publish')}
            </Button>
          )}
        </>
      }
      footer={
        <div className="flex w-full items-center gap-3">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {saveState === 'saved'
              ? t('typeBuilder.allSaved')
              : saveState === 'saving'
                ? tc('actions.saving')
                : t('typeBuilder.unsaved')}
          </span>
        </div>
      }
    >
      <div className="space-y-6 p-1">
        {issues.length > 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="font-medium">
              {t('typeBuilder.resolveIssues', { count: issues.length })}
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {issues.slice(0, 6).map((issue, i) => (
                <li key={i}>{describeIssue(issue)}</li>
              ))}
              {issues.length > 6 ? (
                <li>{t('typeBuilder.moreIssues', { count: issues.length - 6 })}</li>
              ) : null}
            </ul>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className={field}>
            <Label>{t('typeBuilder.nameLabel')}</Label>
            <Input value={name} onChange={(e) => rename(e.target.value)} placeholder={t('typeBuilder.namePlaceholder')} />
          </div>
          <div className={field}>
            <Label>{t('typeBuilder.pluralLabel')}</Label>
            <Input
              value={pluralName}
              onChange={(e) => {
                setPluralTouched(true)
                setPluralName(e.target.value)
              }}
              placeholder={t('typeBuilder.pluralPlaceholder')}
            />
          </div>
          <div className={field}>
            <Label>{t('typeBuilder.keyLabel')}</Label>
            <Input
              value={key}
              disabled={!isDraft}
              className="font-mono text-[13px]"
              onChange={(e) => {
                setKeyTouched(true)
                setKey(e.target.value)
              }}
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {isDraft
                ? t('typeBuilder.keyHelpDraft', { key: key || '…' })
                : t('typeBuilder.keyHelpPinned', { key })}
            </p>
          </div>
          <div className={field}>
            <Label>{t('typeBuilder.iconLabel')}</Label>
            <IconPicker value={iconKey} onChange={setIconKey} />
          </div>
          <div className={cn(field, 'sm:col-span-2')}>
            <Label>{tc('labels.description')}</Label>
            <Textarea
              value={description}
              rows={2}
              placeholder={t('typeBuilder.descriptionPlaceholder')}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={showInNav}
                onChange={(e) => setShowInNav(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
              />
              {t('typeBuilder.showInNav')}
            </label>
            {showInNav ? (
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                {t('typeBuilder.navOrder')}
                <Input
                  type="number"
                  value={String(sortOrder)}
                  onChange={(e) => setSortOrder(Math.trunc(Number(e.target.value)) || 0)}
                  className="h-8 w-20 text-right tabular-nums"
                />
              </label>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label>{t('typeBuilder.audienceLabel')}</Label>
            <div className="flex flex-wrap gap-1.5">
              {roles.map((r) => {
                const on = allowedRoles.includes(r.key)
                return (
                  <button
                    key={r.key}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() =>
                      setAllowedRoles((rs) => (on ? rs.filter((x) => x !== r.key) : [...rs, r.key]))
                    }
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-sm transition-colors',
                      on
                        ? 'border-teal-300 bg-teal-50 font-medium text-teal-800 dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-300'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600',
                    )}
                  >
                    {r.name}
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {allowedRoles.length === 0
                ? t('typeBuilder.audienceOpen')
                : t('typeBuilder.audienceRestricted')}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>{t('typeBuilder.fieldsLabel')}</Label>
            <AddFieldButton onAdd={addField} />
          </div>
          {fields.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-200 px-3 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
              {t('typeBuilder.noFields')}
            </p>
          ) : (
            <div className="space-y-1.5">
              {fields.map((f, i) => (
                <FieldRow
                  key={f.id}
                  field={f}
                  index={i}
                  count={fields.length}
                  allFields={fields}
                  expanded={expanded === f.id}
                  onToggle={() => setExpanded((cur) => (cur === f.id ? null : f.id))}
                  onChange={(patch) => updateField(f.id, patch)}
                  onMove={(dir) => moveField(i, dir)}
                  onRemove={() => removeField(f)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </UrlDrawer>
  )
}

// --- Icon picker ---------------------------------------------------------------

function IconPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="start"
      className="w-64 p-2"
      trigger={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex h-9 w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600"
        >
          <NavIcon iconKey={value} size={15} />
          <span className="font-mono text-[13px]">{value}</span>
          <ChevronDown size={14} className="ml-auto text-slate-400" />
        </button>
      }
    >
      <div className="grid max-h-56 grid-cols-6 gap-1 overflow-auto">
        {ICON_KEYS.map((k) => (
          <button
            key={k}
            type="button"
            title={k}
            onClick={() => {
              onChange(k)
              setOpen(false)
            }}
            className={cn(
              'flex h-9 items-center justify-center rounded transition-colors',
              k === value
                ? 'bg-teal-100 text-teal-800 dark:bg-teal-900/60 dark:text-teal-300'
                : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
            )}
          >
            <NavIcon iconKey={k} size={16} />
          </button>
        ))}
      </div>
    </Popover>
  )
}

// --- Add-field palette ------------------------------------------------------------

function AddFieldButton({ onAdd }: { onAdd: (t: FieldType) => void }) {
  const t = useTranslations('records')
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-72 p-1"
      trigger={
        <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
          <Plus size={14} /> {t('typeBuilder.addField')}
        </Button>
      }
    >
      <div className="max-h-80 overflow-auto">
        {RECORD_FIELD_TYPES.map((fieldType) => (
          <button
            key={fieldType}
            type="button"
            onClick={() => {
              onAdd(fieldType)
              setOpen(false)
            }}
            className="flex w-full flex-col items-start rounded px-2 py-1.5 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60"
          >
            <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
              {t(`fieldTypes.${fieldType}.label`)}
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {t(`fieldTypes.${fieldType}.description`)}
            </span>
          </button>
        ))}
      </div>
    </Popover>
  )
}

// --- Field row + config panel --------------------------------------------------------

function FieldRow({
  field: f,
  index,
  count,
  allFields,
  expanded,
  onToggle,
  onChange,
  onMove,
  onRemove,
}: {
  field: FormField
  index: number
  count: number
  allFields: FormField[]
  expanded: boolean
  onToggle: () => void
  onChange: (patch: Partial<FormField>) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  const t = useTranslations('records')
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronDown
            size={14}
            className={cn('shrink-0 text-slate-400 transition-transform', expanded && 'rotate-180')}
          />
          <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
            {f.label}
            {f.required || f.validation?.required ? <span className="ml-0.5 text-red-500">*</span> : null}
          </span>
          <Badge variant="outline">{t(`fieldTypes.${f.type}.label`)}</Badge>
        </button>
        <Button type="button" variant="ghost" size="icon" aria-label={t('typeBuilder.moveUp')} disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp size={14} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('typeBuilder.moveDown')}
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown size={14} />
        </Button>
        <Button type="button" variant="ghost" size="icon" aria-label={t('typeBuilder.removeField')} onClick={onRemove}>
          <Trash2 size={14} />
        </Button>
      </div>
      {expanded ? (
        <div className="space-y-3 border-t border-slate-100 px-3 py-3 dark:border-slate-800">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className={field}>
              <Label>{t('typeBuilder.fieldLabel')}</Label>
              <Input value={f.label} onChange={(e) => onChange({ label: e.target.value })} />
            </div>
            <div className={field}>
              <Label>{t('typeBuilder.fieldId')}</Label>
              <Input value={f.id} disabled className="font-mono text-[13px]" />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t('typeBuilder.fieldIdHelp')}
              </p>
            </div>
            <div className={cn(field, 'sm:col-span-2')}>
              <Label>{t('typeBuilder.helpText')}</Label>
              <Input
                value={f.helpText ?? ''}
                placeholder={t('typeBuilder.helpTextPlaceholder')}
                onChange={(e) => onChange({ helpText: e.target.value || undefined })}
              />
            </div>
          </div>
          {f.type !== 'formula' ? (
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={Boolean(f.required)}
                onChange={(e) => onChange({ required: e.target.checked || undefined })}
                className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
              />
              {t('typeBuilder.requiredToActivate')}
            </label>
          ) : null}
          <TypeSpecificConfig field={f} allFields={allFields} onChange={onChange} />
        </div>
      ) : null}
    </div>
  )
}

function TypeSpecificConfig({
  field: f,
  allFields,
  onChange,
}: {
  field: FormField
  allFields: FormField[]
  onChange: (patch: Partial<FormField>) => void
}) {
  const t = useTranslations('records.typeBuilder')
  const setConfig = (patch: Record<string, unknown>) => {
    const next = { ...(f.config ?? {}), ...patch }
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k]
    onChange({ config: Object.keys(next).length > 0 ? next : undefined })
  }

  switch (f.type) {
    case 'select':
    case 'multi_select':
    case 'radio':
      return <ChoiceOptionsEditor field={f} onChange={onChange} />
    case 'number':
    case 'currency':
    case 'percentage': {
      const num = (v: unknown) => (typeof v === 'number' ? String(v) : '')
      const parse = (s: string) => {
        const n = Number(s)
        return s.trim() !== '' && Number.isFinite(n) ? n : undefined
      }
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className={field}>
            <Label>{t('minimum')}</Label>
            <Input
              inputMode="decimal"
              defaultValue={num(f.config?.min)}
              onChange={(e) => setConfig({ min: parse(e.target.value) })}
            />
          </div>
          <div className={field}>
            <Label>{t('maximum')}</Label>
            <Input
              inputMode="decimal"
              defaultValue={num(f.config?.max)}
              onChange={(e) => setConfig({ max: parse(e.target.value) })}
            />
          </div>
          {f.type === 'number' ? (
            <div className={field}>
              <Label>{t('unit')}</Label>
              <Input
                defaultValue={typeof f.config?.unit === 'string' ? f.config.unit : ''}
                placeholder={t('unitPlaceholder')}
                onChange={(e) => setConfig({ unit: e.target.value || undefined })}
              />
            </div>
          ) : null}
        </div>
      )
    }
    case 'rating': {
      const max =
        typeof f.config?.max === 'number' && Number.isInteger(f.config.max) ? f.config.max : 5
      return (
        <div className={cn(field, 'max-w-40')}>
          <Label>{t('ratingScale')}</Label>
          <Input
            type="number"
            min={1}
            max={10}
            value={String(max)}
            onChange={(e) => {
              const n = Math.trunc(Number(e.target.value))
              setConfig({ max: Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 5 })
            }}
          />
        </div>
      )
    }
    case 'party': {
      const kind = typeof f.config?.partyKind === 'string' ? f.config.partyKind : 'any'
      return (
        <div className={cn(field, 'max-w-60')}>
          <Label>{t('partyKind')}</Label>
          <SearchSelect
            options={[
              { value: 'any', label: t('partyAny') },
              { value: 'customer', label: t('partyCustomers') },
              { value: 'vendor', label: t('partyVendors') },
              { value: 'employee', label: t('partyEmployees') },
            ]}
            value={kind}
            onChange={(v) => setConfig({ partyKind: v === 'any' ? undefined : v })}
            ariaLabel={t('partyKind')}
          />
        </div>
      )
    }
    case 'formula':
      return <FormulaBuilder field={f} allFields={allFields} onChange={onChange} setConfig={setConfig} />
    default:
      return null
  }
}

// --- Choice options editor -------------------------------------------------------

function ChoiceOptionsEditor({
  field: f,
  onChange,
}: {
  field: FormField
  onChange: (patch: Partial<FormField>) => void
}) {
  const t = useTranslations('records.typeBuilder')
  const options = f.validation?.options ?? []
  const setOptions = (next: { value: string; label: string }[]) =>
    onChange({ validation: { ...(f.validation ?? {}), options: next } })

  return (
    <div className="space-y-1.5">
      <Label>{t('options')}</Label>
      {options.map((o, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={o.label}
            placeholder={t('optionPlaceholder', { n: i + 1 })}
            onChange={(e) => {
              const next = [...options]
              next[i] = { ...o, label: e.target.value }
              setOptions(next)
            }}
          />
          <span className="w-36 shrink-0 truncate font-mono text-xs text-slate-400 dark:text-slate-500">
            {o.value}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('removeOption')}
            disabled={options.length === 1}
            onClick={() => setOptions(options.filter((_, j) => j !== i))}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          const taken = new Set(options.map((o) => o.value))
          let value = `option_${options.length + 1}`
          for (let n = options.length + 2; taken.has(value); n++) value = `option_${n}`
          setOptions([...options, { value, label: '' }])
        }}
      >
        <Plus size={14} /> {t('addOption')}
      </Button>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {t('optionsHelp')}
      </p>
    </div>
  )
}

// --- Formula builder ---------------------------------------------------------------
//
// Authors a single-level typed formula tree: one operation over a list of
// operands (field references or constants). subtract/divide take exactly two
// operands. Deeper nesting stays representable in the stored tree (the
// evaluator and validator support it fully); a tree this builder can't
// decompose is rebuilt from scratch on the first edit.

type SimpleOp = 'sum' | 'product' | 'subtract' | 'divide' | 'min' | 'max' | 'concat'
type Operand = { kind: 'field'; fieldKey: string } | { kind: 'literal'; value: string }

// Operation values only — labels come from records.typeBuilder.formula.ops.<value>.
const OP_VALUES: SimpleOp[] = ['sum', 'subtract', 'product', 'divide', 'min', 'max', 'concat']

function decompose(expr: FormulaExpression | undefined): { op: SimpleOp; operands: Operand[] } | null {
  if (!expr) return { op: 'sum', operands: [] }
  const toOperand = (e: FormulaExpression): Operand | null =>
    e.kind === 'field_ref'
      ? { kind: 'field', fieldKey: e.fieldKey }
      : e.kind === 'literal'
        ? { kind: 'literal', value: String(e.value) }
        : null
  if (expr.kind === 'sum' || expr.kind === 'product' || expr.kind === 'min' || expr.kind === 'max' || expr.kind === 'concat') {
    const operands = expr.of.map(toOperand)
    if (operands.some((o) => o === null)) return null
    return { op: expr.kind, operands: operands as Operand[] }
  }
  if (expr.kind === 'subtract' || expr.kind === 'divide') {
    const left = toOperand(expr.left)
    const right = toOperand(expr.right)
    if (!left || !right) return null
    return { op: expr.kind, operands: [left, right] }
  }
  return null
}

function compose(op: SimpleOp, operands: Operand[], numeric: boolean): FormulaExpression {
  const toExpr = (o: Operand): FormulaExpression =>
    o.kind === 'field'
      ? { kind: 'field_ref', fieldKey: o.fieldKey }
      : {
          kind: 'literal',
          value: numeric && o.value.trim() !== '' && Number.isFinite(Number(o.value)) ? Number(o.value) : o.value,
        }
  if (op === 'subtract' || op === 'divide') {
    const [left, right] = operands
    return {
      kind: op,
      left: left ? toExpr(left) : { kind: 'literal', value: 0 },
      right: right ? toExpr(right) : { kind: 'literal', value: 0 },
    }
  }
  return { kind: op, of: operands.map(toExpr) }
}

function FormulaBuilder({
  field: f,
  allFields,
  onChange,
  setConfig,
}: {
  field: FormField
  allFields: FormField[]
  onChange: (patch: Partial<FormField>) => void
  setConfig: (patch: Record<string, unknown>) => void
}) {
  const t = useTranslations('records.typeBuilder.formula')
  const decomposed = useMemo(() => decompose(f.formula), [f.formula])
  const [advancedReplaced, setAdvancedReplaced] = useState(false)
  const state = decomposed ?? { op: 'sum' as SimpleOp, operands: [] }
  const format = typeof f.config?.format === 'string' ? f.config.format : 'number'

  // Join-text can reference any field (string coercion); arithmetic sticks to
  // numeric-valued fields. Formula-on-formula is allowed — field_ref resolves
  // the referenced formula's computed VALUE (never its tree), and lint rejects
  // self-reference, so evaluation cannot recurse.
  const referencable = allFields.filter(
    (x) =>
      x.id !== f.id &&
      (state.op === 'concat'
        ? true
        : ['number', 'currency', 'percentage', 'rating', 'formula'].includes(x.type)),
  )

  const commit = (op: SimpleOp, operands: Operand[]) => {
    const fixed =
      op === 'subtract' || op === 'divide'
        ? [
            operands[0] ?? { kind: 'literal' as const, value: '0' },
            operands[1] ?? { kind: 'literal' as const, value: '0' },
          ]
        : operands
    onChange({ formula: compose(op, fixed, op !== 'concat') })
  }

  return (
    <div className="space-y-2 rounded-md border border-slate-100 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-800/30">
      {!decomposed && !advancedReplaced ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {t('advancedWarning')}
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={field}>
          <Label>{t('operation')}</Label>
          <SearchSelect
            options={OP_VALUES.map((op) => ({ value: op, label: t(`ops.${op}`) }))}
            value={state.op}
            onChange={(v) => {
              setAdvancedReplaced(true)
              commit(v as SimpleOp, state.operands)
            }}
            ariaLabel={t('operationAria')}
          />
        </div>
        <div className={field}>
          <Label>{t('displayAs')}</Label>
          <SearchSelect
            options={[
              { value: 'number', label: t('formatNumber') },
              { value: 'currency', label: t('formatCurrency') },
              { value: 'percentage', label: t('formatPercentage') },
              { value: 'text', label: t('formatText') },
            ]}
            value={format}
            onChange={(v) => setConfig({ format: v })}
            ariaLabel={t('formatAria')}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>{state.op === 'subtract' || state.op === 'divide' ? t('leftRight') : t('operands')}</Label>
        {state.operands.map((o, i) => (
          <div key={i} className="flex items-center gap-2">
            <SearchSelect
              className="w-40 shrink-0"
              options={[
                { value: 'field', label: t('operandField') },
                { value: 'literal', label: t('operandConstant') },
              ]}
              value={o.kind}
              onChange={(v) => {
                const next = [...state.operands]
                next[i] =
                  v === 'field'
                    ? { kind: 'field', fieldKey: referencable[0]?.id ?? '' }
                    : { kind: 'literal', value: '' }
                setAdvancedReplaced(true)
                commit(state.op, next)
              }}
              ariaLabel={t('operandKindAria')}
            />
            {o.kind === 'field' ? (
              <SearchSelect
                className="flex-1"
                options={referencable.map((x) => ({ value: x.id, label: x.label }))}
                value={o.fieldKey}
                onChange={(v) => {
                  const next = [...state.operands]
                  next[i] = { kind: 'field', fieldKey: v }
                  setAdvancedReplaced(true)
                  commit(state.op, next)
                }}
                placeholder={t('pickFieldPlaceholder')}
                ariaLabel={t('operandFieldAria')}
              />
            ) : (
              <Input
                className="flex-1"
                inputMode={state.op === 'concat' ? 'text' : 'decimal'}
                value={o.value}
                placeholder={state.op === 'concat' ? t('textPlaceholder') : '0'}
                onChange={(e) => {
                  const next = [...state.operands]
                  next[i] = { kind: 'literal', value: e.target.value }
                  setAdvancedReplaced(true)
                  commit(state.op, next)
                }}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('removeOperand')}
              onClick={() => {
                setAdvancedReplaced(true)
                commit(state.op, state.operands.filter((_, j) => j !== i))
              }}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        {state.op === 'subtract' || state.op === 'divide' ? (
          state.operands.length < 2 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setAdvancedReplaced(true)
                commit(state.op, [...state.operands, { kind: 'field', fieldKey: referencable[0]?.id ?? '' }])
              }}
            >
              <Plus size={14} /> {t('addOperand')}
            </Button>
          ) : null
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setAdvancedReplaced(true)
              commit(state.op, [...state.operands, { kind: 'field', fieldKey: referencable[0]?.id ?? '' }])
            }}
          >
            <Plus size={14} /> {t('addOperand')}
          </Button>
        )}
        {state.operands.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('operandsHelp')}
          </p>
        ) : null}
      </div>
    </div>
  )
}
