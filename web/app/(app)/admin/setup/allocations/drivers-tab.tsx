'use client'

import { Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Drawer, Input, Label, SearchSelect, Select } from '@openbooks/ui'
import { PagedTable } from '../../../../../components/paged-table'
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
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={tc('remove')}
            onClick={() => onChange(accountIds.filter((_, j) => j !== i))}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...accountIds, accounts[0]?.id ?? ''])}>
        <Plus size={14} /> {tc('add')}
      </Button>
    </div>
  )
}

/**
 * Drivers tab (A8): registry list, per-source-kind drawer, manual
 * effective-dated values grid, vector preview. A7's shell mounts this
 * island; the temporary page below does the same until the shell lands.
 */
export function DriversTab() {
  const t = useTranslations('allocations.drivers')
  const tc = useTranslations('common')
  const [drivers, setDrivers] = useState<Driver[] | null>(null)
  const [options, setOptions] = useState<Options | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState<{ form: DriverFormState; id?: string; updatedAt?: string | null } | null>(null)
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState<Driver | null>(null)
  const [previewPeriod, setPreviewPeriod] = useState('')
  const [previewDate, setPreviewDate] = useState('')
  const [previewRows, setPreviewRows] = useState<PreviewRow[] | null>(null)
  const [previewNote, setPreviewNote] = useState<string | null>(null)
  const [valuesFor, setValuesFor] = useState<Driver | null>(null)
  const [values, setValues] = useState<DriverValue[] | null>(null)
  const [valueDraft, setValueDraft] = useState({ dimensionValueId: '', effectiveFrom: '', effectiveTo: '', value: '', note: '' })

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
    const payload =
      editing.id === undefined
        ? driverPayloadFromForm(editing.form)
        : { ...driverPayloadFromForm(editing.form), expectedUpdatedAt: editing.updatedAt ?? undefined }
    const res = await fetch(
      editing.id === undefined ? '/api/allocations/drivers' : `/api/allocations/drivers/${editing.id}`,
      {
        method: editing.id === undefined ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )
    setSaving(false)
    if (!res.ok) {
      setError((await res.json().catch(() => ({})) as { error?: string }).error ?? t('saveFailed'))
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

  async function loadValues(driver: Driver) {
    setValuesFor(driver)
    setValues(null)
    const res = await fetch(`/api/allocations/driver-values?driverId=${driver.id}`)
    if (res.ok) setValues(((await res.json()) as { values: DriverValue[] }).values)
  }

  async function addValue() {
    if (!valuesFor) return
    const res = await fetch('/api/allocations/driver-values', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ driverId: valuesFor.id, ...valuePayloadFromForm(valueDraft) }),
    })
    if (!res.ok) {
      setError((await res.json().catch(() => ({})) as { error?: string }).error ?? t('saveFailed'))
      return
    }
    setValueDraft({ dimensionValueId: '', effectiveFrom: '', effectiveTo: '', value: '', note: '' })
    await loadValues(valuesFor)
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
    if (valuesFor) await loadValues(valuesFor)
  }

  function endValue(row: DriverValue, effectiveTo: string) {
    return patchValue(row, { effectiveTo: effectiveTo || null })
  }

  async function removeValue(row: DriverValue) {
    if (!(await confirmDialog(t('deleteValueConfirm')))) return
    const res = await fetch(`/api/allocations/driver-values/${row.id}`, { method: 'DELETE' })
    if (!res.ok) {
      setError((await res.json().catch(() => ({})) as { error?: string }).error ?? t('deleteFailed'))
      return
    }
    if (valuesFor) await loadValues(valuesFor)
  }

  if (!drivers || !options) return <p className="text-sm text-slate-500">{error ?? '…'}</p>

  const form = editing?.form
  const valueDimOptions = valuesFor ? dimensionOptions(t, options, valuesFor.dimension) : []

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">{t('title')}</h3>
        <p className="text-sm text-slate-500">{t('description')}</p>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => setEditing({ form: newDriverForm() })}>
          {t('newDriver')}
        </Button>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          {t('showInactive')}
        </label>
      </div>
      <PagedTable
        rows={drivers}
        rowKey={(row) => row.id}
        empty={<p className="text-sm text-slate-500">{t('empty')}</p>}
        onRowClick={(row) => setEditing({ form: formFromDriver(row), id: row.id, updatedAt: row.updatedAt })}
        columns={[
          { key: 'name', header: t('name'), cell: (row) => row.name, search: (row) => `${row.name} ${row.key}` },
          { key: 'key', header: t('key'), cell: (row) => <span className="tabular-nums">{row.key}</span> },
          { key: 'dimension', header: t('dimension'), cell: (row) => dimensionLabel(t, row.dimension) },
          { key: 'source', header: t('sourceKind'), cell: (row) => t(`sourceKinds.${row.sourceKind}`) },
          { key: 'unit', header: t('unit'), cell: (row) => row.unit ?? '—' },
          {
            key: 'active',
            header: t('active'),
            cell: (row) => (row.isActive ? '✓' : '—'),
          },
          {
            key: 'actions',
            header: '',
            cell: (row) => (
              <span className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                <Button
                  type="button"
                  variant="ghost"
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
                {row.sourceKind === 'manual' ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => void loadValues(row)}>
                    {t('valuesTitle')}
                  </Button>
                ) : null}
                <Button type="button" variant="ghost" size="sm" onClick={() => void remove(row)}>
                  {tc('delete')}
                </Button>
              </span>
            ),
          },
        ]}
      />

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id === undefined ? t('newDriver') : t('editDriver')}
        size="lg"
        footer={
          <span className="flex gap-2">
            <Button type="button" onClick={() => void save()} disabled={saving}>
              {tc('save')}
            </Button>
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>
              {tc('cancel')}
            </Button>
          </span>
        }
      >
        {form ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t('key')}</Label>
                <Input
                  value={form.key}
                  disabled={editing?.id !== undefined}
                  onChange={(e) => setEditing((s) => (s ? { ...s, form: { ...s.form, key: e.target.value } } : s))}
                />
                <p className="text-xs text-slate-500">{t('keyHint')}</p>
              </div>
              <div>
                <Label>{t('name')}</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setEditing((s) => (s ? { ...s, form: { ...s.form, name: e.target.value } } : s))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t('dimension')}</Label>
                <Select
                  value={form.dimension}
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
              </div>
              <div>
                <Label>{t('sourceKind')}</Label>
                <Select
                  value={form.sourceKind}
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
                <p className="text-xs text-slate-500">{t(`sourceHints.${form.sourceKind}`)}</p>
              </div>
            </div>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setEditing((s) => (s ? { ...s, form: { ...s.form, isActive: e.target.checked } } : s))}
              />
              {t('active')}
            </label>
            {form.sourceKind === 'statistical_journal' ? (
              <div>
                <Label>{t('unit')}</Label>
                <Input
                  value={form.unit}
                  placeholder={t('unitPlaceholder')}
                  onChange={(e) => setEditing((s) => (s ? { ...s, form: { ...s.form, unit: e.target.value } } : s))}
                />
              </div>
            ) : null}
            {form.sourceKind === 'gl_activity' || form.sourceKind === 'gl_balance' ? (
              <div className="space-y-2">
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={form.accountScopeAny}
                    onChange={(e) =>
                      setEditing((s) => (s ? { ...s, form: { ...s.form, accountScopeAny: e.target.checked } } : s))
                    }
                  />
                  {t('anyAccountScope')}
                </label>
                {!form.accountScopeAny ? (
                  <AccountIdsEditor
                    accountIds={form.accountIds}
                    accounts={options.accounts}
                    onChange={(accountIds) => setEditing((s) => (s ? { ...s, form: { ...s.form, accountIds } } : s))}
                  />
                ) : null}
              </div>
            ) : null}
            {form.sourceKind === 'statistical_journal' ? (
              <div className="space-y-2">
                <p className="text-xs text-slate-500">{t('accountsHint')}</p>
                <AccountIdsEditor
                  accountIds={form.accountIds}
                  accounts={options.accounts}
                  onChange={(accountIds) => setEditing((s) => (s ? { ...s, form: { ...s.form, accountIds } } : s))}
                />
              </div>
            ) : null}
            {form.sourceKind === 'native_measure' ? (
              <div>
                <Label>{t('measureLabel')}</Label>
                <Select
                  value={form.measure}
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
              </div>
            ) : null}
            {form.sourceKind === 'report_definition' ? (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>{t('reportLabel')}</Label>
                  <SearchSelect
                    value={form.reportDefinitionId}
                    onChange={(v) =>
                      setEditing((s) => (s ? { ...s, form: { ...s.form, reportDefinitionId: v ?? '' } } : s))
                    }
                    options={options.reports.map((r) => ({ value: r.id, label: r.label }))}
                    placeholder={t('reportLabel')}
                  />
                </div>
                <div>
                  <Label>{t('dimensionColumn')}</Label>
                  <Input
                    value={form.dimensionColumn}
                    onChange={(e) =>
                      setEditing((s) => (s ? { ...s, form: { ...s.form, dimensionColumn: e.target.value } } : s))
                    }
                  />
                </div>
                <div>
                  <Label>{t('valueColumn')}</Label>
                  <Input
                    value={form.valueColumn}
                    onChange={(e) =>
                      setEditing((s) => (s ? { ...s, form: { ...s.form, valueColumn: e.target.value } } : s))
                    }
                  />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </Drawer>

      <Drawer
        open={previewing !== null}
        onClose={() => setPreviewing(null)}
        title={t('previewTitle')}
        size="lg"
      >
        {previewing ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t('asOfPeriod')}</Label>
                <SearchSelect
                  value={previewPeriod}
                  onChange={(v) => {
                    setPreviewPeriod(v ?? '')
                    if (v) setPreviewDate('')
                  }}
                  options={options.periods.map((p) => ({ value: p.id, label: `${p.label} (${p.extra})` }))}
                  placeholder={t('asOfPeriod')}
                  clearable
                  emptyLabel={t('asOfPeriod')}
                />
              </div>
              <div>
                <Label>{t('asOfDate')}</Label>
                <Input
                  type="date"
                  value={previewDate}
                  onChange={(e) => {
                    setPreviewDate(e.target.value)
                    if (e.target.value) setPreviewPeriod('')
                  }}
                />
              </div>
            </div>
            <Button type="button" onClick={() => void runPreview()} disabled={!previewPeriod && !previewDate}>
              {t('preview')}
            </Button>
            {previewNote ? <p className="text-sm text-slate-500">{previewNote}</p> : null}
            {previewRows ? (
              previewRows.length === 0 ? (
                <p className="text-sm text-slate-500">{t('noPreviewRows')}</p>
              ) : (
                <PagedTable
                  rows={previewRows}
                  rowKey={(row) => row.id}
                  empty={<p className="text-sm text-slate-500">{t('noPreviewRows')}</p>}
                  columns={[
                    { key: 'label', header: t('dimensionValue'), cell: (row) => row.label, search: (row) => row.label },
                    { key: 'value', header: t('weight'), align: 'right', cell: (row) => <span className="tabular-nums">{row.value}</span> },
                    { key: 'share', header: t('share'), align: 'right', cell: (row) => <span className="tabular-nums">{row.share}</span> },
                  ]}
                />
              )
            ) : null}
          </div>
        ) : null}
      </Drawer>

      <Drawer open={valuesFor !== null} onClose={() => setValuesFor(null)} title={t('valuesTitle')} size="lg">
        <div className="space-y-3">
          <p className="text-sm text-slate-500">{t('valuesHint')}</p>
          {values === null ? (
            <p className="text-sm text-slate-500">…</p>
          ) : values.length === 0 ? (
            <p className="text-sm text-slate-500">{t('noValues')}</p>
          ) : (
            <PagedTable
              rows={values}
              rowKey={(row) => row.id}
              empty={<p className="text-sm text-slate-500">{t('noValues')}</p>}
              columns={[
                {
                  key: 'value',
                  header: t('dimensionValue'),
                  cell: (row) => valueDimOptions.find((o) => o.id === row.dimensionValueId)?.label ?? row.dimensionValueId,
                },
                { key: 'from', header: t('effectiveFrom'), cell: (row) => row.effectiveFrom },
                { key: 'to', header: t('effectiveTo'), cell: (row) => row.effectiveTo ?? t('openEnded') },
                {
                  key: 'amount',
                  header: t('value'),
                  align: 'right',
                  cell: (row) => (
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
                  ),
                },
                {
                  key: 'note',
                  header: t('note'),
                  cell: (row) => (
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
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  cell: (row) => (
                    <span className="flex gap-1">
                      <Input
                        type="date"
                        className="h-8 w-36"
                        defaultValue={row.effectiveTo ?? ''}
                        aria-label={t('endValue')}
                        onBlur={(e) => {
                          if (e.target.value && e.target.value !== (row.effectiveTo ?? '')) void endValue(row, e.target.value)
                        }}
                      />
                      <Button type="button" variant="ghost" size="sm" onClick={() => void removeValue(row)}>
                        {tc('delete')}
                      </Button>
                    </span>
                  ),
                },
              ]}
            />
          )}
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 p-2.5 dark:border-slate-800">
            <div className="col-span-2">
              <Label>{t('dimensionValue')}</Label>
              {valueDimOptions.length > 0 ? (
                <SearchSelect
                  value={valueDraft.dimensionValueId}
                  onChange={(v) => setValueDraft((d) => ({ ...d, dimensionValueId: v ?? '' }))}
                  options={valueDimOptions.map((o) => ({ value: o.id, label: o.label }))}
                  placeholder={t('dimensionValue')}
                />
              ) : (
                <Input
                  value={valueDraft.dimensionValueId}
                  placeholder={t('dimensionValue')}
                  onChange={(e) => setValueDraft((d) => ({ ...d, dimensionValueId: e.target.value }))}
                />
              )}
            </div>
            <div>
              <Label>{t('effectiveFrom')}</Label>
              <Input
                type="date"
                value={valueDraft.effectiveFrom}
                onChange={(e) => setValueDraft((d) => ({ ...d, effectiveFrom: e.target.value }))}
              />
            </div>
            <div>
              <Label>{t('effectiveTo')}</Label>
              <Input
                type="date"
                value={valueDraft.effectiveTo}
                onChange={(e) => setValueDraft((d) => ({ ...d, effectiveTo: e.target.value }))}
              />
            </div>
            <div>
              <Label>{t('value')}</Label>
              <Input
                inputMode="decimal"
                value={valueDraft.value}
                onChange={(e) => setValueDraft((d) => ({ ...d, value: e.target.value }))}
              />
            </div>
            <div>
              <Label>{t('note')}</Label>
              <Input value={valueDraft.note} onChange={(e) => setValueDraft((d) => ({ ...d, note: e.target.value }))} />
            </div>
            <div className="col-span-2">
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
      </Drawer>
    </div>
  )
}
