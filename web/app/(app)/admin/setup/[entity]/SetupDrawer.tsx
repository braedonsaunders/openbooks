'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import {
  Badge,
  Button,
  Input,
  Label,
  SearchSelect,
  Select,
  Textarea,
  UrlDrawer,
  type SelectOption,
} from '@openbooks/ui'
import { toSnake, type SetupEntity, type SetupField } from '../../../../../lib/setup/registry'

type RefOption = { value: string; label: string }

export function NewSetupButton({ entityKey, label }: { entityKey: string; label: string }) {
  const router = useRouter()
  return (
    <Button onClick={() => router.push(`/admin/setup/${entityKey}?row=new`)}>
      <Plus size={15} /> {label}
    </Button>
  )
}

/** Initial form value for one field, read from the (snake-keyed) row. */
function initialValue(field: SetupField, row: Record<string, any> | null): any {
  const raw = row ? row[toSnake(field.key)] : undefined
  if (!row && field.defaultValue !== undefined) return field.defaultValue
  switch (field.kind) {
    case 'boolean':
      // New records default to active/true for the common isActive flag.
      return row ? Boolean(raw) : field.key === 'isActive' || field.key === 'isBillableDefault'
    case 'date':
      return raw ? String(raw).slice(0, 10) : ''
    case 'multiref':
      return [] as string[]
    default:
      return raw == null ? '' : String(raw)
  }
}

export function SetupDrawer({
  entity,
  row,
  members,
  refOptions,
  closeHref: closeHrefProp,
}: {
  entity: SetupEntity
  row: Record<string, any> | null
  members: string[]
  refOptions: Record<string, RefOption[]>
  closeHref?: string
}) {
  const t = useTranslations('admin.setup')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const creating = !row
  const idColumn = entity.idColumn ?? 'id'
  const closeHref = closeHrefProp ?? `/admin/setup/${entity.key}`

  const [form, setForm] = useState<Record<string, any>>(() => {
    const init: Record<string, any> = {}
    for (const f of entity.fields) init[f.key] = f.kind === 'multiref' ? members : initialValue(f, row)
    return init
  })
  const [busy, setBusy] = useState(false)

  const entityTitle = entity.singularTitleKey
    ? t(entity.singularTitleKey)
    : t(`entities.${entity.key}.title`)
  const set = (key: string, value: any) => setForm((f) => ({ ...f, [key]: value }))

  function validate(): string | null {
    for (const f of entity.fields) {
      if (!f.required || f.kind === 'boolean' || f.kind === 'multiref') continue
      if (!creating && f.lockedOnEdit) continue
      const v = form[f.key]
      if (v === undefined || v === null || String(v).trim() === '') {
        return t('validation.required', { field: t(`fields.${f.key}`) })
      }
    }
    return null
  }

  async function save() {
    const err = validate()
    if (err) {
      toast.error(err)
      return
    }
    setBusy(true)
    const body: Record<string, any> = { ...form }
    if (!creating) body.id = row![idColumn]
    const res = await fetch(`/api/admin/setup/${entity.key}`, {
      method: creating ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      toast.error(errorMessage(data?.error))
      return
    }
    toast.success(creating ? t('created') : t('updated'))
    router.push(closeHref)
    router.refresh()
  }

  async function remove() {
    if (!row) return
    if (!confirm(t('confirmDelete'))) return
    setBusy(true)
    const res = await fetch(`/api/admin/setup/${entity.key}?id=${encodeURIComponent(row[idColumn])}`, {
      method: 'DELETE',
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      toast.error(errorMessage(data?.error))
      return
    }
    toast.success(t('deleted'))
    router.push(closeHref)
    router.refresh()
  }

  function errorMessage(code: unknown): string {
    if (code === 'duplicate') return t('errors.duplicate')
    if (code === 'in-use') return t('errors.inUse')
    if (code === 'primary-required') return t('errors.primaryRequired')
    if (code === 'primary-active-required') return t('errors.primaryActiveRequired')
    if (code === 'archive-only') return t('errors.archiveOnly')
    if (typeof code === 'string' && code) return code
    return tCommon('feedback.saveFailed')
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="lg"
      title={creating ? t('drawer.newTitle', { name: entityTitle }) : t('drawer.editTitle', { name: entityTitle })}
      headerActions={
        <Button disabled={busy} onClick={save}>
          {busy ? tCommon('actions.saving') : creating ? tCommon('actions.create') : tCommon('actions.save')}
        </Button>
      }
      footer={
        !creating && !entity.hasActive ? (
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="flex items-center gap-1.5 text-sm text-red-600 hover:text-red-700 disabled:opacity-50 dark:text-red-400"
          >
            <Trash2 size={14} /> {tCommon('actions.delete')}
          </button>
        ) : (
          <span />
        )
      }
    >
      <div className="grid gap-4 p-1 sm:grid-cols-2">
        {entity.fields.map((field) => (
          <FieldControl
            key={field.key}
            field={field}
            value={form[field.key]}
            onChange={(v) => set(field.key, v)}
            creating={creating}
            refOptions={field.ref ? (refOptions[field.ref] ?? []) : []}
            t={t}
          />
        ))}
      </div>
    </UrlDrawer>
  )
}

function FieldControl({
  field,
  value,
  onChange,
  creating,
  refOptions,
  t,
}: {
  field: SetupField
  value: any
  onChange: (v: any) => void
  creating: boolean
  refOptions: RefOption[]
  t: (k: string, params?: Record<string, any>) => string
}) {
  const label = t(`fields.${field.key}`)
  const locked = !creating && field.lockedOnEdit
  const full = field.kind === 'multiref' || field.kind === 'textarea'
  const wrap = full ? 'space-y-1.5 sm:col-span-2' : 'space-y-1.5'

  // Locked natural keys are shown read-only when editing.
  if (locked) {
    return (
      <div className={wrap}>
        <Label>{label}</Label>
        <div className="flex h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 font-mono text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          {String(value ?? '') || '—'}
        </div>
      </div>
    )
  }

  if (field.kind === 'boolean') {
    return (
      <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
        />
        {label}
      </label>
    )
  }

  if (field.kind === 'multiref') {
    const selected: string[] = Array.isArray(value) ? value : []
    return (
      <div className={wrap}>
        <Label>{label}</Label>
        {refOptions.length === 0 ? (
          <p className="text-xs text-slate-400">{t('empty')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {refOptions.map((o) => {
              const on = selected.includes(o.value)
              return (
                <label
                  key={o.value}
                  className="flex items-center gap-1.5 rounded border border-slate-200 px-2 py-1 text-xs dark:border-slate-800"
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) =>
                      onChange(e.target.checked ? [...selected, o.value] : selected.filter((x) => x !== o.value))
                    }
                    className="h-3.5 w-3.5 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                  />
                  {o.label}
                </label>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  if (field.kind === 'ref') {
    const options: SelectOption[] = refOptions.map((o) => ({ value: o.value, label: o.label }))
    return (
      <div className={wrap}>
        <Label>{label}</Label>
        <SearchSelect
          value={String(value ?? '')}
          onChange={onChange}
          options={options}
          placeholder={t('selectPlaceholder')}
          searchPlaceholder={t('searchPlaceholder')}
          sheetTitle={label}
          clearable={!field.required}
          ariaLabel={label}
        />
      </div>
    )
  }

  if (field.kind === 'select') {
    return (
      <div className={wrap}>
        <Label>{label}</Label>
        <Select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {!field.required ? <option value="">—</option> : null}
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {t(o.labelKey)}
            </option>
          ))}
        </Select>
      </div>
    )
  }

  if (field.kind === 'textarea') {
    return (
      <div className={wrap}>
        <Label>{label}</Label>
        <Textarea value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      </div>
    )
  }

  const numeric = field.kind === 'integer' || field.kind === 'decimal' || field.kind === 'percent'
  return (
    <div className={wrap}>
      <Label>{label}</Label>
      <Input
        type={field.kind === 'date' ? 'date' : 'text'}
        inputMode={numeric ? 'decimal' : undefined}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}
