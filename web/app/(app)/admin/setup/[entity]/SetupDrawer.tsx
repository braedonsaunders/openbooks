'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Plus, Trash2, Upload } from 'lucide-react'
import {
  Badge,
  Button,
  Input,
  Label,
  SearchSelect,
  Select,
  Textarea,
  UrlDrawer,
  cn,
  type SelectOption,
} from '@openbooks/ui'
import { toSnake, type SetupEntity, type SetupField } from '../../../../../lib/setup/registry'
import { countryOptions } from '../../../../../lib/countries'

type RefOption = { value: string; label: string }

export function NewSetupButton({
  entityKey,
  label,
  basePath,
}: {
  entityKey: string
  label: string
  /** Host path to open the create drawer under. Defaults to the setup workspace.
   *  When mounted elsewhere (e.g. /inventory), existing query params such as the
   *  active `view` are preserved so the section stays selected. */
  basePath?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  function open() {
    if (basePath) {
      const next = new URLSearchParams(searchParams.toString())
      next.set('row', 'new')
      router.push(`${pathname}?${next.toString()}`)
    } else {
      router.push(`/admin/setup/${entityKey}?row=new`)
    }
  }
  return (
    <Button onClick={open}>
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
    case 'json':
      return raw == null ? '' : JSON.stringify(raw, null, 2)
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
  initialValues,
  fixedValues,
  nestedTab,
  stacked = false,
}: {
  entity: SetupEntity
  row: Record<string, any> | null
  members: string[]
  refOptions: Record<string, RefOption[]>
  closeHref?: string
  initialValues?: Record<string, unknown>
  fixedValues?: Record<string, unknown>
  nestedTab?: { key: string; label: string; content: ReactNode }
  stacked?: boolean
}) {
  const t = useTranslations('admin.setup')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const creating = !row
  const idColumn = entity.idColumn ?? 'id'
  const closeHref = closeHrefProp ?? `/admin/setup/${entity.key}`

  const [form, setForm] = useState<Record<string, any>>(() => {
    const init: Record<string, any> = {}
    for (const f of entity.fields) init[f.key] = f.kind === 'multiref' ? members : initialValue(f, row)
    return { ...init, ...initialValues, ...fixedValues }
  })
  const [busy, setBusy] = useState(false)
  const [officialBusy, setOfficialBusy] = useState(false)

  const entityTitle = entity.singularTitleKey
    ? t(entity.singularTitleKey)
    : t(`entities.${entity.key}.title`)
  const set = (key: string, value: any) => setForm((f) => ({ ...f, [key]: value }))
  const nestedTabActive = !creating && nestedTab != null && searchParams.get('setupTab') === nestedTab.key

  function selectTab(key: 'details' | string) {
    const next = new URLSearchParams(searchParams.toString())
    if (key === 'details') {
      next.delete('setupTab')
      next.delete('boxRow')
      next.delete('rateRow')
      next.delete('valueRow')
    } else {
      next.set('setupTab', key)
    }
    const query = next.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

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
    const body: Record<string, any> = { ...form, ...fixedValues }
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
    if (code === 'invalid-url') return t('errors.invalidUrl')
    if (code === 'invalid-depreciation-formula') return t('errors.invalidDepreciationFormula')
    if (typeof code === 'string' && code) return code
    return tCommon('feedback.saveFailed')
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="lg"
      stacked={stacked}
      title={creating ? t('drawer.newTitle', { name: entityTitle }) : t('drawer.editTitle', { name: entityTitle })}
      subtabs={!creating && nestedTab ? (
        <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label={t('drawer.tabs.ariaLabel')}>
          {[
            { key: 'details', label: t('drawer.tabs.details') },
            { key: nestedTab.key, label: nestedTab.label },
          ].map((tab) => {
            const active = tab.key === 'details' ? !nestedTabActive : nestedTabActive
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => selectTab(tab.key)}
                className={cn(
                  'shrink-0 border-b-2 px-3 py-3 text-sm font-medium transition-colors',
                  active
                    ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200',
                )}
              >
                {tab.label}
              </button>
            )
          })}
        </nav>
      ) : undefined}
      headerActions={
        !nestedTabActive ? <Button disabled={busy} onClick={save}>
          {busy ? tCommon('actions.saving') : creating ? tCommon('actions.create') : tCommon('actions.save')}
        </Button> : undefined
      }
      footer={
        nestedTabActive ? undefined : !creating && !entity.hasActive ? (
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
      {nestedTabActive ? nestedTab?.content : <div className="grid gap-4 p-1 sm:grid-cols-2">
        {entity.fields.filter((field) => !field.hidden).map((field) => (
          <FieldControl
            key={field.key}
            field={field}
            value={form[field.key]}
            onChange={(v) => set(field.key, v)}
            creating={creating}
            forceLocked={Object.hasOwn(fixedValues ?? {}, field.key)}
            refOptions={field.ref ? (refOptions[field.ref] ?? []) : []}
            t={t}
          />
        ))}
        {!creating && entity.key === 'tax-return-forms' ? (
          <div className="space-y-2 border-t border-slate-200 pt-4 sm:col-span-2 dark:border-slate-800">
            <Label>{t('taxOfficial.title')}</Label>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('taxOfficial.description')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="cursor-pointer">
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  className="hidden"
                  disabled={officialBusy}
                  onChange={async (event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (!file) return
                    setOfficialBusy(true)
                    try {
                      const body = new FormData()
                      body.set('file', file)
                      const response = await fetch(`/api/tax/returns/${encodeURIComponent(String(row?.code))}/official-pdf`, { method: 'POST', body })
                      if (!response.ok) throw new Error()
                      toast.success(t('taxOfficial.uploaded'))
                      router.refresh()
                    } catch {
                      toast.error(tCommon('feedback.saveFailed'))
                    } finally {
                      setOfficialBusy(false)
                    }
                  }}
                />
                <span className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900">
                  <Upload size={14} />
                  {officialBusy ? t('taxOfficial.uploading') : t('taxOfficial.upload')}
                </span>
              </label>
              {row?.official_pdf_file_id ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={officialBusy}
                  onClick={async () => {
                    setOfficialBusy(true)
                    try {
                      const response = await fetch(`/api/tax/returns/${encodeURIComponent(String(row.code))}/official-pdf`, { method: 'DELETE' })
                      if (!response.ok) throw new Error()
                      toast.success(t('taxOfficial.removed'))
                      router.refresh()
                    } catch {
                      toast.error(tCommon('feedback.saveFailed'))
                    } finally {
                      setOfficialBusy(false)
                    }
                  }}
                >
                  {t('taxOfficial.remove')}
                </Button>
              ) : (
                <span className="text-xs text-slate-500 dark:text-slate-400">{t('taxOfficial.none')}</span>
              )}
            </div>
          </div>
        ) : null}
      </div>}
    </UrlDrawer>
  )
}

function FieldControl({
  field,
  value,
  onChange,
  creating,
  forceLocked,
  refOptions,
  t,
}: {
  field: SetupField
  value: any
  onChange: (v: any) => void
  creating: boolean
  forceLocked: boolean
  refOptions: RefOption[]
  t: (k: string, params?: Record<string, any>) => string
}) {
  const locale = useLocale()
  const countries = useMemo(() => countryOptions(locale), [locale])
  const label = t(`fields.${field.key}`)
  const locked = forceLocked || (!creating && field.lockedOnEdit)
  const full = field.kind === 'multiref' || field.kind === 'textarea' || field.kind === 'json'
  const wrap = full ? 'space-y-1.5 sm:col-span-2' : 'space-y-1.5'
  const lockedDisplay = field.kind === 'ref'
    ? (refOptions.find((option) => option.value === String(value))?.label ?? value)
    : value

  // Locked natural keys are shown read-only when editing.
  if (locked) {
    return (
      <div className={wrap}>
        <Label>{label}</Label>
        <div className="flex h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 font-mono text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          {String(lockedDisplay ?? '') || '—'}
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

  if (field.kind === 'country') {
    return (
      <div className={wrap}>
        <Label>{label}</Label>
        <SearchSelect
          value={String(value ?? '')}
          onChange={onChange}
          options={countries}
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

  if (field.kind === 'textarea' || field.kind === 'json') {
    return (
      <div className={wrap}>
        <Label>{label}</Label>
        <Textarea className={field.kind === 'json' ? 'min-h-40 font-mono text-xs' : undefined} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
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
