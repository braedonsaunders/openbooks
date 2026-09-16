'use client'

import { Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Badge,
  Button,
  Drawer,
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
} from '@openbooks/ui'
import { PagedTable } from '../../../../../components/paged-table'
import { ShowInactivePill } from '../../../../../components/show-inactive-pill'
import { confirmDialog } from '../../../../../lib/confirm'
import {
  driverPayloadFromForm,
  formFromDriver,
  newDriverForm,
  valuePayloadFromForm,
  type DriverFormState,
  type DriverSourceKind,
} from './driver-form'

interface Driver {
  id: string
  key: string
  name: string
  description: string | null
  unit: string | null
  dimension: string
  sourceKind: DriverSourceKind
  config: Record<string, unknown>
  isActive: boolean
  updatedAt?: string | null
}

interface DriverValue {
  id: string
  dimensionValueId: string
  effectiveFrom: string
  effectiveTo: string | null
  value: string
  note: string | null
}

interface Option {
  id: string
  label: string
  extra?: string
}

interface Options {
  accounts: Option[]
  departments: Option[]
  locations: Option[]
  classes: Option[]
  projects: Option[]
  subsidiaries: Option[]
  books: Option[]
  periods: Option[]
  rules: Option[]
  reports: Option[]
}

interface PreviewRow {
  id: string
  label: string
  value: string
  share: string
}

const SOURCE_KINDS: DriverSourceKind[] = [
  'statistical_journal',
  'gl_activity',
  'gl_balance',
  'native_measure',
  'manual',
  'report_definition',
]

const DIMENSIONS = ['department', 'location', 'class', 'project', 'subsidiary'] as const

const CHECKBOX_CLASS = 'h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500'

/** House drawer field — the SetupDrawer shape: label with `?` help, control below. */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label help={hint}>{label}</Label>
      {children}
    </div>
  )
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  children: React.ReactNode
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
      <input type="checkbox" className={CHECKBOX_CLASS} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  )
}

/** House drawer section heading — the SetupDrawer sectionKey style verbatim. */
function DrawerSection({
  title,
  first,
  children,
}: {
  title: string
  first?: boolean
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <h3
        className={
          first
            ? 'text-sm font-semibold text-slate-800 dark:text-slate-100'
            : 'border-t border-slate-200 pt-4 text-sm font-semibold text-slate-800 dark:border-slate-800 dark:text-slate-100'
        }
      >
        {title}
      </h3>
      {children}
    </section>
  )
}

function dimensionOptions(t: (key: string) => string, options: Options, dimension: string): Option[] {
  void t
  switch (dimension) {
    case 'department':
      return options.departments
    case 'location':
      return options.locations
    case 'class':
      return options.classes
    case 'project':
      return options.projects
    case 'subsidiary':
      return options.subsidiaries
    default:
      return []
  }
}

function dimensionLabel(t: (key: string) => string, dimension: string): string {
  if ((DIMENSIONS as readonly string[]).includes(dimension)) return t(`dimensions.${dimension}`)
  return dimension.replace(/^extra:/, '')
}

function AccountIdsEditor({
  accountIds,
  accounts,
  onChange,
}: {
  accountIds: string[]
  accounts: Option[]
  onChange: (ids: string[]) => void
}) {
  const tc = useTranslations('common')
  return (
    <div className="space-y-2">
      {accountIds.map((id, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="flex-1">
            <SearchSelect
              value={id}
              onChange={(v) => onChange(accountIds.map((current, j) => (j === i ? (v ?? '') : current)))}
              options={accounts.map((a) => ({ value: a.id, label: a.label }))}
              placeholder=""
              ariaLabel={tc('actions.add')}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={tc('actions.remove')}
            onClick={() => onChange(accountIds.filter((_, j) => j !== i))}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...accountIds, accounts[0]?.id ?? ''])}>
        <Plus size={14} /> {tc('actions.add')}
      </Button>
    </div>
  )
}

/**
 * Effective-dated manual values, living INSIDE the driver drawer as a
 * section (not behind a separate ghost button). Amounts stay exact decimal
 * text end to end — never coerced through Number.
 */
function ManualValuesSection({
  driver,
  options,
  justSaved,
}: {
  driver: Driver
  options: Options
  justSaved: boolean
}) {
  const t = useTranslations('allocations.drivers')
  const tc = useTranslations('common')
  const [values, setValues] = useState<DriverValue[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [valueDraft, setValueDraft] = useState({ dimensionValueId: '', effectiveFrom: '', effectiveTo: '', value: '', note: '' })
  const valueDimOptions = dimensionOptions(t, options, driver.dimension)

  // The host keys this section by driver id, so a fresh mount (values null
  // = loading) covers driver switches. Same fetch-in-then shape as the
  // parent tab so the settled state lands through the promise, not the
  // effect body.
  const load = useCallback(() => {
    fetch(`/api/allocations/driver-values?driverId=${driver.id}`).then(
      async (res) => {
        if (res.ok) {
          setError(null)
          setValues(((await res.json()) as { values: DriverValue[] }).values)
        } else {
          setError(t('loadFailed'))
        }
      },
      () => setError(t('loadFailed')),
    )
  }, [driver.id, t])

  useEffect(() => {
    load()
  }, [load])

  async function addValue() {
    const res = await fetch('/api/allocations/driver-values', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ driverId: driver.id, ...valuePayloadFromForm(valueDraft) }),
    })
    if (!res.ok) {
      setError((await res.json().catch(() => ({})) as { error?: string }).error ?? t('saveFailed'))
      return
    }
    setValueDraft({ dimensionValueId: '', effectiveFrom: '', effectiveTo: '', value: '', note: '' })
    load()
  }

  async function patchValue(row: DriverValue, patch: Record<string, unknown>) {
    const res = await fetch(`/api/allocations/driver-values/${row.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) {
      setError((await res.json().catch(() => ({})) as { error?: string }).error ?? t('saveFailed'))
      return
    }
    load()
  }

  async function removeValue(row: DriverValue) {
    if (!(await confirmDialog(t('deleteValueConfirm')))) return
    const res = await fetch(`/api/allocations/driver-values/${row.id}`, { method: 'DELETE' })
    if (!res.ok) {
      setError((await res.json().catch(() => ({})) as { error?: string }).error ?? t('deleteFailed'))
      return
    }
    load()
  }

  return (
    <div className="space-y-3">
      {justSaved ? (
        <p className="rounded-md border border-teal-200 bg-teal-50 p-2.5 text-sm text-teal-800 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-200">
          {t('valuesAfterSave')}
        </p>
      ) : null}
      <p className="text-sm text-slate-500 dark:text-slate-400">{t('valuesHint')}</p>
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {values === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">…</p>
      ) : values.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('noValues')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('dimensionValue')}</TableHead>
              <TableHead>{t('effectiveFrom')}</TableHead>
              <TableHead>{t('effectiveTo')}</TableHead>
              <TableHead className="text-right">{t('value')}</TableHead>
              <TableHead>{t('note')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('endValue')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {values.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  {valueDimOptions.find((o) => o.id === row.dimensionValueId)?.label ?? row.dimensionValueId}
                </TableCell>
                <TableCell className="tabular-nums">{row.effectiveFrom}</TableCell>
                <TableCell className="tabular-nums">{row.effectiveTo ?? t('openEnded')}</TableCell>
                <TableCell className="text-right">
                  <Input
                    className="h-8 w-28 text-right tabular-nums"
                    inputMode="decimal"
                    defaultValue={row.value}
                    key={`${row.id}-${row.value}`}
                    aria-label={t('value')}
                    onBlur={(e) => {
                      if (e.target.value.trim() !== row.value) void patchValue(row, { value: e.target.value.trim() })
                    }}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    className="h-8 w-32"
                    defaultValue={row.note ?? ''}
                    key={`${row.id}-${row.note ?? ''}`}
                    aria-label={t('note')}
                    onBlur={(e) => {
                      const next = e.target.value.trim() || null
                      if (next !== row.note) void patchValue(row, { note: next })
                    }}
                  />
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-1">
                    <Input
                      type="date"
                      className="h-8 w-36"
                      defaultValue={row.effectiveTo ?? ''}
                      aria-label={t('endValue')}
                      onBlur={(e) => {
                        if (e.target.value && e.target.value !== (row.effectiveTo ?? '')) {
                          void patchValue(row, { effectiveTo: e.target.value || null })
                        }
                      }}
                    />
                    <Button type="button" variant="ghost" size="sm" onClick={() => void removeValue(row)}>
                      {tc('actions.delete')}
                    </Button>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 dark:border-slate-800">
        <div className="sm:col-span-2">
          <Field label={t('dimensionValue')}>
            {valueDimOptions.length > 0 ? (
              <SearchSelect
                value={valueDraft.dimensionValueId}
                onChange={(v) => setValueDraft((d) => ({ ...d, dimensionValueId: v ?? '' }))}
                options={valueDimOptions.map((o) => ({ value: o.id, label: o.label }))}
                placeholder={t('dimensionValue')}
                sheetTitle={t('dimensionValue')}
                ariaLabel={t('dimensionValue')}
              />
            ) : (
              <Input
                value={valueDraft.dimensionValueId}
                placeholder={t('dimensionValue')}
                aria-label={t('dimensionValue')}
                onChange={(e) => setValueDraft((d) => ({ ...d, dimensionValueId: e.target.value }))}
              />
            )}
          </Field>
        </div>
        <Field label={t('effectiveFrom')}>
          <Input
            type="date"
            value={valueDraft.effectiveFrom}
            aria-label={t('effectiveFrom')}
            onChange={(e) => setValueDraft((d) => ({ ...d, effectiveFrom: e.target.value }))}
          />
        </Field>
        <Field label={t('effectiveTo')}>
          <Input
            type="date"
            value={valueDraft.effectiveTo}
            aria-label={t('effectiveTo')}
            onChange={(e) => setValueDraft((d) => ({ ...d, effectiveTo: e.target.value }))}
          />
        </Field>
        <Field label={t('value')}>
          <Input
            inputMode="decimal"
            value={valueDraft.value}
            aria-label={t('value')}
            onChange={(e) => setValueDraft((d) => ({ ...d, value: e.target.value }))}
          />
        </Field>
        <Field label={t('note')}>
          <Input
            value={valueDraft.note}
            aria-label={t('note')}
            onChange={(e) => setValueDraft((d) => ({ ...d, note: e.target.value }))}
          />
        </Field>
        <div className="sm:col-span-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void addValue()}
            disabled={!valueDraft.dimensionValueId || !valueDraft.effectiveFrom || !valueDraft.value}
          >
            {t('addValue')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Drivers tab: registry list, SetupDrawer-style per-source-kind drawer with
 * the manual effective-dated values grid inside, and a vector preview
 * drawer. The header New action lives above the list so it stays visible on
 * an empty tenant; empty tenants get the shared EmptyState with the same
 * New-driver primary action.
 */
export function DriversTab() {
  const t = useTranslations('allocations.drivers')
  const tc = useTranslations('common')
  const [drivers, setDrivers] = useState<Driver[] | null>(null)
  const [options, setOptions] = useState<Options | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState<{ form: DriverFormState; id?: string; updatedAt?: string | null; justSavedManual?: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState<Driver | null>(null)
  const [previewPeriod, setPreviewPeriod] = useState('')
  const [previewDate, setPreviewDate] = useState('')
  const [previewRows, setPreviewRows] = useState<PreviewRow[] | null>(null)
  const [previewNote, setPreviewNote] = useState<string | null>(null)

  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch(`/api/allocations/drivers${showInactive ? '?includeInactive=1' : ''}`),
      fetch('/api/allocations/options'),
    ]).then(
      async ([driversRes, optionsRes]) => {
        if (cancelled) return
        if (!driversRes.ok || !optionsRes.ok) {
          setError(t('loadFailed'))
          return
        }
        setError(null)
        setDrivers(((await driversRes.json()) as { drivers: Driver[] }).drivers)
        setOptions((await optionsRes.json()) as Options)
      },
      () => {
        if (!cancelled) setError(t('loadFailed'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [showInactive, t, reloadKey])

  async function save() {
    if (!editing) return
    setSaving(true)
    setError(null)
    const creating = editing.id === undefined
    const payload =
      creating
        ? driverPayloadFromForm(editing.form)
        : { ...driverPayloadFromForm(editing.form), expectedUpdatedAt: editing.updatedAt ?? undefined }
    const res = await fetch(
      creating ? '/api/allocations/drivers' : `/api/allocations/drivers/${editing.id}`,
      {
        method: creating ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )
    const body = (await res.json().catch(() => ({}))) as { driver?: Driver; error?: string }
    setSaving(false)
    if (!res.ok) {
      setError(body.error ?? t('saveFailed'))
      return
    }
    // A manual driver saved for the first time stays open with its values
    // section ready: values need a driver id, which only exists after save.
    if (creating && editing.form.sourceKind === 'manual' && body.driver?.id) {
      setEditing({
        form: formFromDriver(body.driver),
        id: body.driver.id,
        updatedAt: body.driver.updatedAt,
        justSavedManual: true,
      })
      reload()
      return
    }
    setEditing(null)
    reload()
  }

  async function remove(driver: Driver) {
    if (!(await confirmDialog(t('deleteConfirm', { name: driver.name })))) return
    const res = await fetch(`/api/allocations/drivers/${driver.id}`, { method: 'DELETE' })
    if (!res.ok) {
      setError((await res.json().catch(() => ({})) as { error?: string }).error ?? t('deleteFailed'))
      return
    }
    reload()
  }

  async function runPreview() {
    if (!previewing) return
    setPreviewRows(null)
    setPreviewNote(null)
    const body = previewPeriod ? { driverId: previewing.id, periodId: previewPeriod } : { driverId: previewing.id, date: previewDate }
    const res = await fetch('/api/allocations/drivers/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as { rows?: PreviewRow[]; errorCode?: string; error?: string }
    if (!res.ok) {
      setPreviewNote(res.status === 503 ? t('enginePending') : (json.error ?? t('previewFailed')))
      return
    }
    setPreviewRows(json.rows ?? [])
  }

  if (!drivers || !options) return <p className="text-sm text-slate-500 dark:text-slate-400">{error ?? '…'}</p>

  const form = editing?.form
  const creating = editing?.id === undefined
  const showValuesSection = editing != null && !creating && editing.form.sourceKind === 'manual'

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          {t('description')}
        </p>
        <Button type="button" onClick={() => setEditing({ form: newDriverForm() })}>
          <Plus size={15} />
          {t('newDriver')}
        </Button>
      </div>
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      <div className="overflow-x-auto">
        <PagedTable
          rows={drivers}
          rowKey={(row) => row.id}
          searchable
          emptyAsRow
          toolbarAfter={<ShowInactivePill checked={showInactive} onChange={setShowInactive} />}
          empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('empty')}</p>}
          onRowClick={(row) => setEditing({ form: formFromDriver(row), id: row.id, updatedAt: row.updatedAt })}
            columns={[
              { key: 'name', header: t('name'), cell: (row) => <span className="font-medium">{row.name}</span>, search: (row) => `${row.name} ${row.key}` },
              { key: 'key', header: t('key'), cell: (row) => <code className="text-xs">{row.key}</code>, search: (row) => row.key },
              { key: 'dimension', header: t('dimension'), cell: (row) => dimensionLabel(t, row.dimension) },
              { key: 'source', header: t('sourceKind'), cell: (row) => t(`sourceKinds.${row.sourceKind}`) },
              { key: 'unit', header: t('unit'), cell: (row) => row.unit ?? '—' },
              {
                key: 'active',
                header: t('active'),
                cell: (row) => (
                  <Badge variant={row.isActive ? 'success' : 'outline'}>
                    {row.isActive ? t('active') : t('inactive')}
                  </Badge>
                ),
              },
              {
                key: 'actions',
                header: '',
                cell: (row) => (
                  <span className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setPreviewing(row)
                        setPreviewRows(null)
                        setPreviewNote(null)
                        setPreviewPeriod(options.periods[0]?.id ?? '')
                        setPreviewDate('')
                      }}
                    >
                      {t('preview')}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => void remove(row)}>
                      {tc('actions.delete')}
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        </div>

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={creating ? t('newDriver') : t('editDriver')}
        description={creating ? undefined : editing?.form.key}
        size="xl"
        headerActions={
          <Button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? tc('actions.saving') : creating ? tc('actions.create') : tc('actions.save')}
          </Button>
        }
      >
        {form ? (
          <div className="space-y-5 p-1">
            {/* No body heading: the drawer title already names the record —
                the SetupDrawer composition. */}
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('key')} hint={t('keyHint')}>
                  <Input
                    value={form.key}
                    disabled={!creating}
                    aria-label={t('key')}
                    onChange={(e) => setEditing((s) => (s ? { ...s, form: { ...s.form, key: e.target.value } } : s))}
                  />
                </Field>
                <Field label={t('name')}>
                  <Input
                    value={form.name}
                    aria-label={t('name')}
                    onChange={(e) => setEditing((s) => (s ? { ...s, form: { ...s.form, name: e.target.value } } : s))}
                  />
                </Field>
              </div>
              <Field label={t('fieldDescription')}>
                <Input
                  value={form.description}
                  aria-label={t('fieldDescription')}
                  onChange={(e) => setEditing((s) => (s ? { ...s, form: { ...s.form, description: e.target.value } } : s))}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('dimension')}>
                  <Select
                    value={form.dimension}
                    aria-label={t('dimension')}
                    onChange={(e) => setEditing((s) => (s ? { ...s, form: { ...s.form, dimension: e.target.value } } : s))}
                  >
                    {(DIMENSIONS as readonly string[]).includes(form.dimension)
                      ? DIMENSIONS.map((d) => (
                          <option key={d} value={d}>
                            {t(`dimensions.${d}`)}
                          </option>
                        ))
                      : [
                          ...DIMENSIONS.map((d) => (
                            <option key={d} value={d}>
                              {t(`dimensions.${d}`)}
                            </option>
                          )),
                          <option key={form.dimension} value={form.dimension}>
                            {dimensionLabel(t, form.dimension)}
                          </option>,
                        ]}
                  </Select>
                </Field>
                <Field label={t('sourceKind')} hint={t(`sourceHints.${form.sourceKind}`)}>
                  <Select
                    value={form.sourceKind}
                    aria-label={t('sourceKind')}
                    onChange={(e) =>
                      setEditing((s) =>
                        s ? { ...s, form: { ...s.form, sourceKind: e.target.value as DriverSourceKind } } : s,
                      )
                    }
                  >
                    {SOURCE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t(`sourceKinds.${k}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('unit')}>
                  <Input
                    value={form.unit}
                    placeholder={t('unitPlaceholder')}
                    aria-label={t('unit')}
                    onChange={(e) => setEditing((s) => (s ? { ...s, form: { ...s.form, unit: e.target.value } } : s))}
                  />
                </Field>
                <div className="self-end pb-2">
                  <Check
                    checked={form.isActive}
                    onChange={(isActive) => setEditing((s) => (s ? { ...s, form: { ...s.form, isActive } } : s))}
                  >
                    {t('active')}
                  </Check>
                </div>
              </div>
            </div>
            {form.sourceKind === 'statistical_journal' ? (
              <DrawerSection title={t(`sourceKinds.${form.sourceKind}`)}>
                <Field label={t('unit')} hint={t('accountsHint')}>
                  <Input
                    value={form.unit}
                    placeholder={t('unitPlaceholder')}
                    aria-label={t('unit')}
                    onChange={(e) => setEditing((s) => (s ? { ...s, form: { ...s.form, unit: e.target.value } } : s))}
                  />
                </Field>
                <AccountIdsEditor
                  accountIds={form.accountIds}
                  accounts={options.accounts}
                  onChange={(accountIds) => setEditing((s) => (s ? { ...s, form: { ...s.form, accountIds } } : s))}
                />
              </DrawerSection>
            ) : null}
            {form.sourceKind === 'gl_activity' || form.sourceKind === 'gl_balance' ? (
              <DrawerSection title={t(`sourceKinds.${form.sourceKind}`)}>
                <Check
                  checked={form.accountScopeAny}
                  onChange={(accountScopeAny) =>
                    setEditing((s) => (s ? { ...s, form: { ...s.form, accountScopeAny } } : s))
                  }
                >
                  {t('anyAccountScope')}
                </Check>
                {!form.accountScopeAny ? (
                  <AccountIdsEditor
                    accountIds={form.accountIds}
                    accounts={options.accounts}
                    onChange={(accountIds) => setEditing((s) => (s ? { ...s, form: { ...s.form, accountIds } } : s))}
                  />
                ) : null}
              </DrawerSection>
            ) : null}
            {form.sourceKind === 'native_measure' ? (
              <DrawerSection title={t(`sourceKinds.${form.sourceKind}`)}>
                <Field label={t('measureLabel')}>
                  <Select
                    value={form.measure}
                    aria-label={t('measureLabel')}
                    onChange={(e) => setEditing((s) => (s ? { ...s, form: { ...s.form, measure: e.target.value } } : s))}
                  >
                    {(['headcount', 'labor_hours', 'billed_hours', 'labor_cost', 'revenue', 'direct_cost', 'rentable_area'] as const).map(
                      (m) => (
                        <option key={m} value={m}>
                          {t(`measures.${m}`)}
                        </option>
                      ),
                    )}
                  </Select>
                </Field>
              </DrawerSection>
            ) : null}
            {form.sourceKind === 'report_definition' ? (
              <DrawerSection title={t(`sourceKinds.${form.sourceKind}`)}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('reportLabel')}>
                    <SearchSelect
                      value={form.reportDefinitionId}
                      onChange={(v) =>
                        setEditing((s) => (s ? { ...s, form: { ...s.form, reportDefinitionId: v ?? '' } } : s))
                      }
                      options={options.reports.map((r) => ({ value: r.id, label: r.label }))}
                      placeholder={t('reportLabel')}
                      sheetTitle={t('reportLabel')}
                      ariaLabel={t('reportLabel')}
                    />
                  </Field>
                  <Field label={t('dimensionColumn')}>
                    <Input
                      value={form.dimensionColumn}
                      aria-label={t('dimensionColumn')}
                      onChange={(e) =>
                        setEditing((s) => (s ? { ...s, form: { ...s.form, dimensionColumn: e.target.value } } : s))
                      }
                    />
                  </Field>
                </div>
                <Field label={t('valueColumn')}>
                  <Input
                    value={form.valueColumn}
                    aria-label={t('valueColumn')}
                    onChange={(e) =>
                      setEditing((s) => (s ? { ...s, form: { ...s.form, valueColumn: e.target.value } } : s))
                    }
                  />
                </Field>
              </DrawerSection>
            ) : null}
            {form.sourceKind === 'manual' && creating ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{t('manualCreateHint')}</p>
            ) : null}
            {showValuesSection && editing?.id ? (
              <DrawerSection title={t('valuesTitle')}>
                <ManualValuesSection
                  key={editing.id}
                  driver={{
                    id: editing.id,
                    key: form.key,
                    name: form.name,
                    description: null,
                    unit: null,
                    dimension: form.dimension,
                    sourceKind: form.sourceKind,
                    config: {},
                    isActive: form.isActive,
                  }}
                  options={options}
                  justSaved={editing.justSavedManual === true}
                />
              </DrawerSection>
            ) : null}
          </div>
        ) : null}
      </Drawer>

      <Drawer
        open={previewing !== null}
        onClose={() => setPreviewing(null)}
        title={t('previewTitle')}
        description={previewing ? `${previewing.key} · ${previewing.name}` : undefined}
        size="lg"
        headerActions={
          <Button type="button" onClick={() => void runPreview()} disabled={!previewPeriod && !previewDate}>
            {t('preview')}
          </Button>
        }
      >
        {previewing ? (
          <div className="space-y-4 p-1">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('asOfPeriod')}>
                <SearchSelect
                  value={previewPeriod}
                  onChange={(v) => {
                    setPreviewPeriod(v ?? '')
                    if (v) setPreviewDate('')
                  }}
                  options={options.periods.map((p) => ({ value: p.id, label: `${p.label} (${p.extra})` }))}
                  placeholder={t('asOfPeriod')}
                  sheetTitle={t('asOfPeriod')}
                  ariaLabel={t('asOfPeriod')}
                  clearable
                  emptyLabel={t('asOfPeriod')}
                />
              </Field>
              <Field label={t('asOfDate')}>
                <Input
                  type="date"
                  value={previewDate}
                  aria-label={t('asOfDate')}
                  onChange={(e) => {
                    setPreviewDate(e.target.value)
                    if (e.target.value) setPreviewPeriod('')
                  }}
                />
              </Field>
            </div>
            {previewNote ? <p className="text-sm text-slate-500 dark:text-slate-400">{previewNote}</p> : null}
            {previewRows ? (
              previewRows.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">{t('noPreviewRows')}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('dimensionValue')}</TableHead>
                      <TableHead className="text-right">{t('weight')}</TableHead>
                      <TableHead className="text-right">{t('share')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewRows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>{row.label}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.value}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.share}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}
