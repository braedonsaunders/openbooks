'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Label, SearchSelect, Select, UrlDrawer } from '@openbooks/ui'
import { SplitLinesEditor } from '../../../../../components/allocations/SplitLinesEditor'
import type { AllocationLine } from '../../../../../components/allocations/split-lines-model'
import type { AllocationRuleTarget, AllocationRuleVersion } from '@openbooks/engine/src/allocations/types.ts'
import { confirmDialog } from '../../../../../lib/confirm'
import {
  apiError,
  blankDefinitionForm,
  definitionFormFromVersion,
  definitionPayload,
  EDITABLE_FILTER_DIMS,
  generalFormFromRule,
  generalPayload,
  mergeLinesToTargets,
  targetToLine,
  testLinePayload,
  type DefinitionForm,
  type GeneralForm,
} from './rule-drawer-form'

type DrawerTab = 'general' | 'definition' | 'versions' | 'test'

interface RuleHead {
  id: string
  key: string
  name: string
  description?: string | null
  mode: 'entry' | 'post' | 'period'
  sortOrder: number
  isActive: boolean
}

interface VersionEntry {
  version: Record<string, unknown> & {
    id: string
    versionNo: number
    status: 'draft' | 'published' | 'retired'
    effectiveFrom: string
    effectiveTo?: string | null
    definitionHash?: string | null
  }
  revision: string
  targetCount: number
}

interface RuleDetail {
  rule: RuleHead
  revision: string
  versions: VersionEntry[]
}

interface VersionDetail {
  version: AllocationRuleVersion
  targets: AllocationRuleTarget[]
  revision: string
}

interface Option {
  id: string
  label: string
  extra?: string
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

/** Checkbox list for id-array fields (books, accounts, dimension filters). */
function MultiCheck({
  options,
  values,
  onChange,
  ariaLabel,
}: {
  options: { value: string; label: string }[]
  values: string[]
  onChange: (next: string[]) => void
  ariaLabel: string
}) {
  const selected = new Set(values)
  return (
    <div aria-label={ariaLabel} className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2 dark:border-slate-800">
      {options.map((option) => (
        <label key={option.value} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={selected.has(option.value)}
            onChange={(e) => {
              const next = new Set(selected)
              if (e.target.checked) next.add(option.value)
              else next.delete(option.value)
              onChange([...next])
            }}
          />
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
        </label>
      ))}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
      {hint ? <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{hint}</p> : null}
    </div>
  )
}

function ErrorBox({ message, onRetry, retryLabel }: { message: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
      <p>{message}</p>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Rule drawer host: `?rule=<id>` opens the editor, `?rule=new` opens create.
 * The slot mounts this only when the param is present; UrlDrawer owns the
 * close navigation back to the list (list state preserved via closeHref).
 */
const TABS: DrawerTab[] = ['general', 'definition', 'versions', 'test']

export function RuleDrawerHost({ ruleParam, closeHref }: { ruleParam: string; closeHref: string }) {
  if (ruleParam === 'new') return <RuleCreateDrawer closeHref={closeHref} />
  return <RuleEditDrawer key={ruleParam} ruleId={ruleParam} closeHref={closeHref} />
}

function TabStrip({ tab, onTab }: { tab: DrawerTab; onTab: (tab: DrawerTab) => void }) {
  const t = useTranslations('allocations')
  const labels: Record<DrawerTab, string> = {
    general: t('rules.drawer.tabs.general'),
    definition: t('rules.drawer.tabs.definition'),
    versions: t('rules.drawer.tabs.versions'),
    test: t('rules.drawer.tabs.test'),
  }
  return (
    <div role="tablist" aria-label={t('rules.tabsAria')} className="flex gap-1">
      {TABS.map((key) => (
        <button
          key={key}
          role="tab"
          aria-selected={tab === key}
          type="button"
          onClick={() => onTab(key)}
          className={
            tab === key
              ? 'rounded-md bg-teal-50 px-3 py-1.5 text-sm font-medium text-teal-800 dark:bg-teal-950/40 dark:text-teal-200'
              : 'rounded-md px-3 py-1.5 text-sm text-slate-500 hover:text-slate-800 dark:text-slate-400'
          }
        >
          {labels[key]}
        </button>
      ))}
    </div>
  )
}

/** Create mode: head fields, then one POST builds head + initial draft. */
function RuleCreateDrawer({ closeHref }: { closeHref: string }) {
  const t = useTranslations('allocations')
  return (
    <UrlDrawer open closeHref={closeHref} title={t('rules.drawer.newTitle')} size="lg">
      <RuleCreateBody closeHref={closeHref} />
    </UrlDrawer>
  )
}

function RuleCreateBody({ closeHref }: { closeHref: string }) {
  const t = useTranslations('allocations')
  const tc = useTranslations('common')
  const router = useRouter()
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'entry' | 'post' | 'period'>('entry')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const create = async () => {
    setSaving(true)
    setError(null)
    const { status, body } = await fetchJson('/api/allocations/rules', {
      method: 'POST',
      body: JSON.stringify({ key, name, mode, description: description === '' ? null : description }),
    })
    setSaving(false)
    if (status !== 201) {
      setError(apiError(status, body, t('rules.errors.save')).message)
      return
    }
    const id = (body as { rule?: { id?: string } })?.rule?.id
    if (typeof id === 'string' && id !== '') {
      const params = new URLSearchParams({ rule: id })
      router.push(`/admin/setup/allocations?${params.toString()}` as never)
    } else {
      router.push(closeHref as never)
    }
  }

  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">{t('rules.drawer.newTitle')}</h2>
      {error ? <ErrorBox message={error} /> : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('rules.general.key')} hint={t('rules.general.keyHint')}>
          <Input value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Field label={t('rules.general.mode')} hint={t('rules.general.modeHint')}>
          <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="entry">{t('rules.modes.entry')}</option>
            <option value="post">{t('rules.modes.post')}</option>
            <option value="period">{t('rules.modes.period')}</option>
          </Select>
        </Field>
      </div>
      <Field label={t('rules.general.name')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('rules.general.description')}>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <span className="flex gap-2">
        <Button type="button" onClick={() => void create()} disabled={saving || key === '' || name === ''}>
          {t('rules.drawer.create')}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.push(closeHref as never)}>
          {tc('cancel')}
        </Button>
      </span>
    </div>
  )
}

interface PickerOptions {
  accounts: Option[]
  departments: Option[]
  locations: Option[]
  classes: Option[]
  projects: Option[]
  subsidiaries: Option[]
  books: Option[]
  periods: Option[]
}

/** Edit mode: loads head + versions + pickers once, then one tab body at a time. */
function RuleEditDrawer({ ruleId, closeHref }: { ruleId: string; closeHref: string }) {
  const t = useTranslations('allocations')
  const [tab, setTab] = useState<DrawerTab>('general')
  const [detail, setDetail] = useState<RuleDetail | null>(null)
  const [options, setOptions] = useState<PickerOptions | null>(null)
  const [drivers, setDrivers] = useState<{ id: string; key: string; name: string; dimension: string; isActive: boolean }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [requestKey, setRequestKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let live = true
    const load = async () => {
      setError(null)
      const [detailRes, optionsRes, driversRes] = await Promise.all([
        fetchJson(`/api/allocations/rules/${encodeURIComponent(ruleId)}`, { signal: controller.signal }),
        fetchJson('/api/allocations/options', { signal: controller.signal }),
        fetchJson('/api/allocations/drivers', { signal: controller.signal }),
      ])
      if (!live) return
      if (detailRes.status === 404) {
        setError(t('rules.drawer.notFound'))
        return
      }
      if (detailRes.status !== 200 || optionsRes.status !== 200) {
        setError(apiError(detailRes.status, detailRes.body, t('rules.errors.load')).message)
        return
      }
      setDetail(detailRes.body as RuleDetail)
      const payload = optionsRes.body as Record<string, Option[]>
      setOptions({
        accounts: payload['accounts'] ?? [],
        departments: payload['departments'] ?? [],
        locations: payload['locations'] ?? [],
        classes: payload['classes'] ?? [],
        projects: payload['projects'] ?? [],
        subsidiaries: payload['subsidiaries'] ?? [],
        books: payload['books'] ?? [],
        periods: payload['periods'] ?? [],
      })
      if (driversRes.status === 200) {
        setDrivers((driversRes.body as { drivers?: typeof drivers })?.drivers ?? [])
      }
    }
    void load().catch((loadError: unknown) => {
      if (live && !(loadError instanceof DOMException && loadError.name === 'AbortError')) {
        setError(loadError instanceof Error ? loadError.message : t('rules.errors.load'))
      }
    })
    return () => {
      live = false
      controller.abort()
    }
  }, [ruleId, requestKey, t])

  const reload = () => {
    setDetail(null)
    setRequestKey((key) => key + 1)
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      title={detail ? t('rules.drawer.editTitle', { name: detail.rule.name }) : t('rules.drawer.loading')}
      description={detail ? detail.rule.key : undefined}
      size="2xl"
      subtabs={<TabStrip tab={tab} onTab={setTab} />}
    >
      {error ? (
        <ErrorBox message={error} onRetry={reload} retryLabel={t('rules.drawer.retry')} />
      ) : detail === null || options === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('rules.drawer.loading')}</p>
      ) : tab === 'general' ? (
        <GeneralTab detail={detail} onSaved={setDetail} onStale={reload} />
      ) : tab === 'definition' ? (
        <DefinitionTab ruleId={ruleId} detail={detail} options={options} drivers={drivers} onChanged={reload} />
      ) : tab === 'versions' ? (
        <VersionsTab ruleId={ruleId} detail={detail} onChanged={reload} />
      ) : (
        <TestTab ruleId={ruleId} detail={detail} options={options} />
      )}
    </UrlDrawer>
  )
}

/** General tab: head identity/ordering; key + mode are immutable after create. */
function GeneralTab({
  detail,
  onSaved,
  onStale,
}: {
  detail: RuleDetail
  onSaved: (detail: RuleDetail) => void
  onStale: () => void
}) {
  const t = useTranslations('allocations')
  const tc = useTranslations('common')
  const [form, setForm] = useState<GeneralForm>(() => generalFormFromRule(detail.rule))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const modeLabels: Record<RuleHead['mode'], string> = {
    entry: t('rules.modes.entry'),
    post: t('rules.modes.post'),
    period: t('rules.modes.period'),
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    const { status, body } = await fetchJson(`/api/allocations/rules/${encodeURIComponent(detail.rule.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(generalPayload(form, detail.revision)),
    })
    setSaving(false)
    if (status !== 200) {
      const failure = apiError(status, body, t('rules.errors.save'))
      if (failure.stale) {
        setError(t('rules.errors.stale'))
        onStale()
        return
      }
      setError(failure.message)
      return
    }
    const rule = (body as { rule?: RuleHead })?.rule
    if (rule) onSaved({ ...detail, rule, revision: (body as { rule?: { revision?: string } })?.rule?.revision ?? detail.revision })
  }

  return (
    <div className="space-y-3">
      {error ? <ErrorBox message={error} /> : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('rules.general.key')} hint={t('rules.general.keyHint')}>
          <Input value={detail.rule.key} disabled />
        </Field>
        <Field label={t('rules.general.mode')} hint={t('rules.general.modeHint')}>
          <Input value={modeLabels[detail.rule.mode]} disabled />
        </Field>
      </div>
      <Field label={t('rules.general.name')}>
        <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label={t('rules.general.description')}>
        <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('rules.general.sortOrder')} hint={t('rules.general.sortOrderHint')}>
          <Input
            value={form.sortOrder}
            inputMode="numeric"
            onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
          />
        </Field>
        <label className="flex items-center gap-1.5 self-end pb-2 text-sm">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
          />
          {t('rules.general.isActive')}
        </label>
      </div>
      <Button type="button" onClick={() => void save()} disabled={saving || form.name.trim() === ''}>
        {tc('save')}
      </Button>
    </div>
  )
}

/** Definition tab: the draft version editor (window/books/applicability/basis/targets/policy). */
function DefinitionTab({
  ruleId,
  detail,
  options,
  drivers,
  onChanged,
}: {
  ruleId: string
  detail: RuleDetail
  options: PickerOptions
  drivers: { id: string; key: string; name: string; dimension: string; isActive: boolean }[]
  onChanged: () => void
}) {
  const t = useTranslations('allocations')
  const tc = useTranslations('common')
  const defaultVersionId =
    detail.versions.find((entry) => entry.version.id === (detail.rule as { currentVersionId?: string }).currentVersionId)?.version.id
    ?? detail.versions.find((entry) => entry.version.status === 'draft')?.version.id
    ?? detail.versions[0]?.version.id
    ?? ''
  const [versionId, setVersionId] = useState(defaultVersionId)
  const [loaded, setLoaded] = useState<VersionDetail | null>(null)
  const [form, setForm] = useState<DefinitionForm>(blankDefinitionForm())
  const [lines, setLines] = useState<AllocationLine[]>([])
  const [docKindInput, setDocKindInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (versionId === '') return
    const controller = new AbortController()
    let live = true
    void fetchJson(
      `/api/allocations/rules/${encodeURIComponent(ruleId)}/versions/${encodeURIComponent(versionId)}`,
      { signal: controller.signal },
    ).then(({ status, body }) => {
      if (!live) return
      if (status !== 200) {
        setError(apiError(status, body, t('rules.errors.load')).message)
        return
      }
      const payload = body as VersionDetail
      setLoaded(payload)
      setForm(definitionFormFromVersion(payload.version))
      setLines(((payload.targets ?? []) as Parameters<typeof targetToLine>[0][]).map(targetToLine))
    })
    return () => {
      live = false
      controller.abort()
    }
  }, [ruleId, versionId, t])

  const isDraft = (loaded?.version?.status as string | undefined) === 'draft'
  const set = <K extends keyof DefinitionForm>(key: K, value: DefinitionForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  const save = async () => {
    if (!loaded) return
    setSaving(true)
    setError(null)
    setSaved(false)
    const versionUrl = `/api/allocations/rules/${encodeURIComponent(ruleId)}/versions/${encodeURIComponent(versionId)}`
    const patched = await fetchJson(versionUrl, {
      method: 'PATCH',
      body: JSON.stringify(definitionPayload(form, loaded.revision)),
    })
    if (patched.status !== 200) {
      setSaving(false)
      const failure = apiError(patched.status, patched.body, t('rules.errors.save'))
      setError(failure.stale ? t('rules.errors.stale') : failure.message)
      if (failure.stale) onChanged()
      return
    }
    let revision = (patched.body as { version?: { revision?: string } })?.version?.revision ?? loaded.revision
    if (form.targetKind === 'explicit') {
      const replaced = await fetchJson(`${versionUrl}/targets`, {
        method: 'PUT',
        body: JSON.stringify({ targets: mergeLinesToTargets(loaded.targets, lines), expectedRevision: revision }),
      })
      if (replaced.status !== 200) {
        setSaving(false)
        const failure = apiError(replaced.status, replaced.body, t('rules.errors.save'))
        setError(failure.stale ? t('rules.errors.stale') : failure.message)
        if (failure.stale) onChanged()
        return
      }
      revision = (replaced.body as { revision?: string })?.revision ?? revision
    }
    setSaving(false)
    setSaved(true)
    setLoaded({ ...loaded, revision })
  }

  const filterLabels: Record<string, string> = {
    department: t('rules.definition.filters.department'),
    location: t('rules.definition.filters.location'),
    class: t('rules.definition.filters.class'),
    project: t('rules.definition.filters.project'),
    subsidiary: t('rules.definition.filters.subsidiary'),
  }
  const accountOptions = options.accounts.map((account) => ({ value: account.id, label: account.label }))
  const driverOptions = [
    ...drivers.map((driver) => ({ value: driver.id, label: `${driver.key} · ${driver.name}` })),
    ...(form.driverId !== '' && !drivers.some((driver) => driver.id === form.driverId)
      ? [{ value: form.driverId, label: form.driverId }]
      : []),
  ]
  const filters = (loaded?.version?.dimensionFilters ?? {}) as Record<string, unknown>
  const readonlyFilters =
    (Array.isArray(filters['partyIds']) && filters['partyIds'].length > 0)
    || (Array.isArray(filters['itemIds']) && filters['itemIds'].length > 0)
    || (typeof filters['extraDims'] === 'object' && filters['extraDims'] !== null && Object.keys(filters['extraDims']).length > 0)
  const dynamicDimOptions = ((): { value: string; label: string }[] => {
    const dims: { value: string; label: string }[] = [
      { value: 'department', label: t('rules.test.department') },
      { value: 'location', label: t('rules.test.location') },
      { value: 'class', label: t('rules.test.class') },
      { value: 'project', label: t('rules.test.project') },
      { value: 'subsidiary', label: t('rules.test.subsidiary') },
    ]
    return dims
  })()
  const dynamicValues: { value: string; label: string }[] = ((): { value: string; label: string }[] => {
    const map: Record<string, Option[]> = {
      department: options.departments,
      location: options.locations,
      class: options.classes,
      project: options.projects,
      subsidiary: options.subsidiaries,
    }
    return (map[form.dynamicDimension] ?? []).map((item) => ({ value: item.id, label: item.label }))
  })()

  return (
    <div className="space-y-4">
      <Field label={t('rules.test.version')}>
        <Select
          value={versionId}
          onChange={(e) => {
            setVersionId(e.target.value)
            setLoaded(null)
            setError(null)
            setSaved(false)
          }}
        >
          {detail.versions.map((entry) => (
            <option key={entry.version.id} value={entry.version.id}>
              {t('rules.versions.version', { n: entry.version.versionNo })} · {entry.version.status}
            </option>
          ))}
        </Select>
      </Field>
      {error ? <ErrorBox message={error} /> : null}
      {loaded === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('rules.drawer.loading')}</p>
      ) : (
        <>
          {!isDraft ? <p className="text-sm text-slate-500 dark:text-slate-400">{t('rules.definition.readOnly')}</p> : null}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t('rules.definition.windowHeading')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('rules.definition.effectiveFrom')}>
                <Input type="date" value={form.effectiveFrom} disabled={!isDraft} onChange={(e) => set('effectiveFrom', e.target.value)} />
              </Field>
              <Field label={t('rules.definition.effectiveTo')}>
                <Input type="date" value={form.effectiveTo} disabled={!isDraft} onChange={(e) => set('effectiveTo', e.target.value)} />
              </Field>
            </div>
            <Field label={t('rules.definition.bookScope')}>
              <Select value={form.bookScope} disabled={!isDraft} onChange={(e) => set('bookScope', e.target.value as DefinitionForm['bookScope'])}>
                <option value="primary">{t('rules.definition.bookScopes.primary')}</option>
                <option value="all_posting">{t('rules.definition.bookScopes.all_posting')}</option>
                <option value="books">{t('rules.definition.bookScopes.books')}</option>
              </Select>
            </Field>
            {form.bookScope === 'books' ? (
              <MultiCheck
                ariaLabel={t('rules.definition.bookScope')}
                options={options.books.map((book) => ({ value: book.id, label: book.label }))}
                values={form.bookIds}
                onChange={(bookIds) => set('bookIds', bookIds)}
              />
            ) : null}
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t('rules.definition.applicabilityHeading')}</h3>
            <div>
              <Label>{t('rules.definition.documentKinds')}</Label>
              <div className="flex flex-wrap gap-1.5">
                {form.documentKinds.map((kind) => (
                  <span key={kind} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800">
                    {kind}
                    {isDraft ? (
                      <button type="button" aria-label={`${tc('delete')} ${kind}`} onClick={() => set('documentKinds', form.documentKinds.filter((k) => k !== kind))}>×</button>
                    ) : null}
                  </span>
                ))}
              </div>
              {isDraft ? (
                <span className="mt-1.5 flex gap-2">
                  <Input value={docKindInput} onChange={(e) => setDocKindInput(e.target.value)} placeholder={t('rules.definition.documentKinds')} />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={docKindInput.trim() === ''}
                    onClick={() => {
                      const kind = docKindInput.trim()
                      if (kind !== '' && !form.documentKinds.includes(kind)) set('documentKinds', [...form.documentKinds, kind])
                      setDocKindInput('')
                    }}
                  >
                    {t('rules.targets.add')}
                  </Button>
                </span>
              ) : null}
            </div>
            <Field label={t('rules.definition.accountScope')}>
              <Select value={form.accountScopeKind} disabled={!isDraft} onChange={(e) => set('accountScopeKind', e.target.value as DefinitionForm['accountScopeKind'])}>
                <option value="any">{t('rules.definition.accountScopes.any')}</option>
                <option value="accounts">{t('rules.definition.accountScopes.accounts')}</option>
                <option value="account_group">{t('rules.definition.accountScopes.account_group')}</option>
              </Select>
            </Field>
            {form.accountScopeKind === 'accounts' ? (
              <MultiCheck
                ariaLabel={t('rules.definition.accountScope')}
                options={accountOptions}
                values={form.accountIds}
                onChange={(accountIds) => set('accountIds', accountIds)}
              />
            ) : null}
            {form.accountScopeKind === 'account_group' ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('rules.definition.accountGroupDimension')}>
                  <Input value={form.accountGroupDimension} disabled={!isDraft} onChange={(e) => set('accountGroupDimension', e.target.value)} />
                </Field>
                <Field label={t('rules.definition.accountGroup')}>
                  <Input value={form.accountGroupKey} disabled={!isDraft} onChange={(e) => set('accountGroupKey', e.target.value)} />
                </Field>
              </div>
            ) : null}
            <div>
              <Label>{t('rules.definition.filtersHeading')}</Label>
              <div className="space-y-2">
                {EDITABLE_FILTER_DIMS.map((dim) => {
                  const source: Record<string, Option[]> = {
                    department: options.departments,
                    location: options.locations,
                    class: options.classes,
                    project: options.projects,
                    subsidiary: options.subsidiaries,
                  }
                  const filterKey = `filter${dim.charAt(0).toUpperCase()}${dim.slice(1)}Ids` as keyof DefinitionForm
                  return (
                    <div key={dim}>
                      <Label>{filterLabels[dim]}</Label>
                      <MultiCheck
                        ariaLabel={filterLabels[dim] ?? dim}
                        options={(source[dim] ?? []).map((item) => ({ value: item.id, label: item.label }))}
                        values={form[filterKey] as string[]}
                        onChange={(next) => set(filterKey, next as never)}
                      />
                    </div>
                  )
                })}
              </div>
              <div className="mt-2 space-y-1">
                <Label>{t('rules.definition.filtersUntagged')}</Label>
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('rules.definition.filtersUntaggedHint')}</p>
                {(['department', 'location', 'class', 'project'] as const).map((dim) => (
                  <label key={dim} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      disabled={!isDraft}
                      checked={form.requireUntagged.includes(dim)}
                      onChange={(e) =>
                        set(
                          'requireUntagged',
                          e.target.checked
                            ? [...form.requireUntagged, dim]
                            : form.requireUntagged.filter((d) => d !== dim),
                        )
                      }
                    />
                    {filterLabels[dim]}
                  </label>
                ))}
              </div>
              {readonlyFilters ? (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('rules.definition.filtersReadonly')}</p>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('rules.definition.applyPolicy')}>
                <Select value={form.applyPolicy} disabled={!isDraft} onChange={(e) => set('applyPolicy', e.target.value as DefinitionForm['applyPolicy'])}>
                  <option value="automatic">{t('rules.definition.applyPolicies.automatic')}</option>
                  <option value="suggest">{t('rules.definition.applyPolicies.suggest')}</option>
                  <option value="manual">{t('rules.definition.applyPolicies.manual')}</option>
                </Select>
              </Field>
              <Field label={t('rules.definition.sourceMeasure')}>
                <Select value={form.sourceMeasure} disabled={!isDraft} onChange={(e) => set('sourceMeasure', e.target.value as DefinitionForm['sourceMeasure'])}>
                  <option value="period_activity">{t('rules.definition.sourceMeasures.period_activity')}</option>
                  <option value="period_end_balance">{t('rules.definition.sourceMeasures.period_end_balance')}</option>
                  <option value="ytd_activity">{t('rules.definition.sourceMeasures.ytd_activity')}</option>
                </Select>
              </Field>
            </div>
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t('rules.definition.basisHeading')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('rules.definition.basisKind')}>
                <Select value={form.basisKind} disabled={!isDraft} onChange={(e) => set('basisKind', e.target.value as DefinitionForm['basisKind'])}>
                  <option value="fixed_percent">{t('rules.definition.basisKinds.fixed_percent')}</option>
                  <option value="driver">{t('rules.definition.basisKinds.driver')}</option>
                  <option value="stepped">{t('rules.definition.basisKinds.stepped')}</option>
                </Select>
              </Field>
              <Field label={t('rules.definition.driverAsOf')}>
                <Select value={form.driverAsOf} disabled={!isDraft} onChange={(e) => set('driverAsOf', e.target.value as DefinitionForm['driverAsOf'])}>
                  <option value="period">{t('rules.definition.driverAsOfs.period')}</option>
                  <option value="document_date">{t('rules.definition.driverAsOfs.document_date')}</option>
                  <option value="prior_period">{t('rules.definition.driverAsOfs.prior_period')}</option>
                </Select>
              </Field>
            </div>
            {form.basisKind === 'driver' ? (
              <Field label={t('rules.definition.driver')}>
                <SearchSelect
                  value={form.driverId}
                  onChange={(value) => set('driverId', value ?? '')}
                  options={driverOptions}
                  disabled={!isDraft}
                />
              </Field>
            ) : null}
            {form.basisKind === 'stepped' ? (
              <div>
                <Label>{t('rules.definition.tiersHeading')}</Label>
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('rules.definition.tierOpenEnded')}</p>
                <div className="mt-1.5 space-y-2">
                  {form.tiers.map((tier, index) => (
                    <span key={index} className="flex items-center gap-2">
                      <Input
                        value={tier.upTo}
                        disabled={!isDraft}
                        inputMode="decimal"
                        placeholder={t('rules.definition.tierUpTo')}
                        aria-label={t('rules.definition.tierUpTo')}
                        onChange={(e) =>
                          set('tiers', form.tiers.map((current, j) => (j === index ? { ...current, upTo: e.target.value } : current)))
                        }
                      />
                      <Input
                        value={tier.targetKey}
                        disabled={!isDraft}
                        placeholder={t('rules.definition.tierTargetKey')}
                        aria-label={t('rules.definition.tierTargetKey')}
                        onChange={(e) =>
                          set('tiers', form.tiers.map((current, j) => (j === index ? { ...current, targetKey: e.target.value } : current)))
                        }
                      />
                      {isDraft ? (
                        <Button type="button" variant="ghost" size="sm" onClick={() => set('tiers', form.tiers.filter((_, j) => j !== index))}>
                          {t('rules.definition.tierRemove')}
                        </Button>
                      ) : null}
                    </span>
                  ))}
                </div>
                {isDraft ? (
                  <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => set('tiers', [...form.tiers, { upTo: '', targetKey: '' }])}>
                    {t('rules.definition.tierAdd')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t('rules.definition.targetsHeading')}</h3>
            <Field label={t('rules.definition.targetKind')}>
              <Select value={form.targetKind} disabled={!isDraft} onChange={(e) => set('targetKind', e.target.value as DefinitionForm['targetKind'])}>
                <option value="explicit">{t('rules.definition.targetKinds.explicit')}</option>
                <option value="dynamic">{t('rules.definition.targetKinds.dynamic')}</option>
              </Select>
            </Field>
            {form.targetKind === 'explicit' ? (
              <SplitLinesEditor
                lines={lines}
                onChange={(next) => {
                  setLines(next)
                  setSaved(false)
                }}
                accountOptions={accountOptions}
                codings={(['department', 'location', 'class', 'project'] as const).map((dim) => ({
                  key: dim,
                  label: filterLabels[dim] ?? dim,
                  options: {
                    department: options.departments,
                    location: options.locations,
                    class: options.classes,
                    project: options.projects,
                  }[dim].map((item) => ({ value: item.id, label: item.label })),
                }))}
                portionKinds={['remainder', 'percent', 'weight']}
                allowEmptyAccount
                showLabel
                labels={{
                  account: t('rules.targets.account'),
                  sameAccount: t('rules.targets.sameAccount'),
                  portion: t('rules.targets.portion'),
                  addLine: t('rules.targets.add'),
                  removeLine: t('rules.targets.remove'),
                  labelPlaceholder: t('rules.targets.labelPlaceholder'),
                }}
              />
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('rules.definition.dynamicDimension')}>
                    <Select
                      value={form.dynamicDimension}
                      disabled={!isDraft}
                      onChange={(e) => set('dynamicDimension', e.target.value as DefinitionForm['dynamicDimension'])}
                    >
                      <option value="">{t('rules.definition.dynamicDimensionNone')}</option>
                      {dynamicDimOptions.map((dim) => (
                        <option key={dim.value} value={dim.value}>
                          {dim.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('rules.definition.dynamicMinWeight')}>
                    <Input
                      value={form.dynamicMinWeight}
                      disabled={!isDraft}
                      inputMode="decimal"
                      onChange={(e) => set('dynamicMinWeight', e.target.value)}
                    />
                  </Field>
                </div>
                <div>
                  <Label>{t('rules.definition.dynamicInclude')}</Label>
                  <MultiCheck
                    ariaLabel={t('rules.definition.dynamicInclude')}
                    options={dynamicValues}
                    values={form.dynamicInclude}
                    onChange={(next) => set('dynamicInclude', next)}
                  />
                </div>
                <div>
                  <Label>{t('rules.definition.dynamicExclude')}</Label>
                  <MultiCheck
                    ariaLabel={t('rules.definition.dynamicExclude')}
                    options={dynamicValues}
                    values={form.dynamicExclude}
                    onChange={(next) => set('dynamicExclude', next)}
                  />
                </div>
                <Field label={t('rules.definition.offsetAccount')}>
                  <SearchSelect
                    value={form.dynamicTargetAccountId}
                    onChange={(value) => set('dynamicTargetAccountId', value ?? '')}
                    options={accountOptions}
                    disabled={!isDraft}
                  />
                </Field>
              </div>
            )}
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t('rules.definition.impactHeading')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('rules.definition.impact')}>
                <Select value={form.impact} disabled={!isDraft} onChange={(e) => set('impact', e.target.value as DefinitionForm['impact'])}>
                  <option value="reclass">{t('rules.definition.impacts.reclass')}</option>
                  <option value="net_zero_pair">{t('rules.definition.impacts.net_zero_pair')}</option>
                  <option value="report_only">{t('rules.definition.impacts.report_only')}</option>
                </Select>
              </Field>
              <Field label={t('rules.definition.solveMethod')}>
                <Select value={form.solveMethod} disabled={!isDraft} onChange={(e) => set('solveMethod', e.target.value as DefinitionForm['solveMethod'])}>
                  <option value="sequential">{t('rules.definition.solveMethods.sequential')}</option>
                  <option value="simultaneous">{t('rules.definition.solveMethods.simultaneous')}</option>
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('rules.definition.offsetAccount')}>
                <SearchSelect
                  value={form.offsetAccountId}
                  onChange={(value) => set('offsetAccountId', value ?? '')}
                  options={accountOptions}
                  disabled={!isDraft}
                />
              </Field>
              <Field label={t('rules.definition.residualPolicy')}>
                <Select value={form.residualPolicy} disabled={!isDraft} onChange={(e) => set('residualPolicy', e.target.value as DefinitionForm['residualPolicy'])}>
                  <option value="largest_share">{t('rules.definition.residualPolicies.largest_share')}</option>
                  <option value="first_target">{t('rules.definition.residualPolicies.first_target')}</option>
                  <option value="last_target">{t('rules.definition.residualPolicies.last_target')}</option>
                  <option value="explicit_target">{t('rules.definition.residualPolicies.explicit_target')}</option>
                </Select>
              </Field>
            </div>
            {form.residualPolicy === 'explicit_target' ? (
              <Field label={t('rules.definition.residualTarget')}>
                <SearchSelect
                  value={form.residualTargetId}
                  onChange={(value) => set('residualTargetId', value ?? '')}
                  options={accountOptions}
                  disabled={!isDraft}
                />
              </Field>
            ) : null}
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t('rules.definition.scheduleHeading')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('rules.definition.runPolicy')}>
                <Select value={form.runPolicy} disabled={!isDraft} onChange={(e) => set('runPolicy', e.target.value as DefinitionForm['runPolicy'])}>
                  <option value="manual">{t('rules.definition.runPolicies.manual')}</option>
                  <option value="auto_preview">{t('rules.definition.runPolicies.auto_preview')}</option>
                  <option value="auto_post">{t('rules.definition.runPolicies.auto_post')}</option>
                </Select>
              </Field>
              <Field label={t('rules.definition.runOffsetDays')}>
                <Input
                  value={form.runOffsetDays}
                  disabled={!isDraft}
                  inputMode="numeric"
                  onChange={(e) => set('runOffsetDays', e.target.value)}
                />
              </Field>
            </div>
            <Field label={t('rules.definition.approvalFlow')} hint={t('rules.definition.approvalFlowHint')}>
              <Input value={form.approvalFlowId} disabled={!isDraft} onChange={(e) => set('approvalFlowId', e.target.value)} />
            </Field>
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t('rules.definition.presentationHeading')}</h3>
            <Field label={t('rules.definition.memoTemplate')}>
              <Input value={form.memoTemplate} disabled={!isDraft} onChange={(e) => set('memoTemplate', e.target.value)} />
            </Field>
            <Field label={t('rules.definition.lineDescriptionTemplate')}>
              <Input
                value={form.lineDescriptionTemplate}
                disabled={!isDraft}
                onChange={(e) => set('lineDescriptionTemplate', e.target.value)}
              />
            </Field>
          </section>
          {isDraft ? (
            <span className="flex items-center gap-2">
              <Button type="button" onClick={() => void save()} disabled={saving}>
                {tc('save')}
              </Button>
              {saved ? <span className="text-sm text-teal-700 dark:text-teal-300">{t('rules.targets.saved')}</span> : null}
            </span>
          ) : null}
        </>
      )}
    </div>
  )
}

/** Versions tab: the timeline with new-version, publish, and retire wiring. */
function VersionsTab({
  ruleId,
  detail,
  onChanged,
}: {
  ruleId: string
  detail: RuleDetail
  onChanged: () => void
}) {
  const t = useTranslations('allocations')
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<{ message?: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [retiring, setRetiring] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const currentId = (detail.rule as { currentVersionId?: string | null }).currentVersionId ?? null
  const statusLabels: Record<VersionEntry['version']['status'], string> = {
    draft: t('rules.statuses.draft'),
    published: t('rules.statuses.published'),
    retired: t('rules.statuses.retired'),
  }

  /** POST a version transition; each action keeps its literal path for audit. */
  const transition = async (url: string, payload: Record<string, unknown>) => {
    setBusy(true)
    setError(null)
    setProblems([])
    const { status, body } = await fetchJson(url, { method: 'POST', body: JSON.stringify(payload) })
    setBusy(false)
    if (status !== 200) {
      const failure = apiError(status, body, t('rules.errors.save'))
      const record = body as { problems?: { message?: string }[] } | null
      if (Array.isArray(record?.problems) && record.problems.length > 0) setProblems(record.problems)
      setError(failure.stale ? t('rules.errors.stale') : failure.message)
      if (failure.stale) onChanged()
      return
    }
    setRetiring(null)
    setReason('')
    onChanged()
  }

  const versionBaseUrl = (versionId: string) =>
    `/api/allocations/rules/${encodeURIComponent(ruleId)}/versions/${encodeURIComponent(versionId)}`

  const createVersion = async () => {
    setBusy(true)
    setError(null)
    const { status, body } = await fetchJson(`/api/allocations/rules/${encodeURIComponent(ruleId)}/versions`, {
      method: 'POST',
      body: JSON.stringify(currentId ? { fromVersionId: currentId } : {}),
    })
    setBusy(false)
    if (status !== 201) {
      const failure = apiError(status, body, t('rules.errors.save'))
      setError(failure.message)
      return
    }
    onChanged()
  }

  const publish = async (entry: VersionEntry) => {
    if (!(await confirmDialog(t('rules.drawer.publishConfirm')))) return
    await transition(`${versionBaseUrl(entry.version.id)}/publish`, {})
  }

  const retire = async (entry: VersionEntry) => {
    if (reason.trim() === '') {
      setError(t('rules.errors.retireReasonRequired'))
      return
    }
    await transition(`${versionBaseUrl(entry.version.id)}/retire`, { reason: reason.trim() })
  }

  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">{t('rules.versions.heading')}</h2>
      {error ? <ErrorBox message={error} /> : null}
      {problems.length > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
          <p className="font-medium">{t('rules.problems.title')}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {problems.map((problem, index) => (
              <li key={index}>{problem.message ?? t('rules.problems.fallback')}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {detail.versions.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('rules.versions.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {detail.versions.map((entry) => (
            <li key={entry.version.id} className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t('rules.versions.version', { n: entry.version.versionNo })}</span>
                <Badge>{statusLabels[entry.version.status]}</Badge>
                {entry.version.id === currentId ? <Badge>{t('rules.versions.current')}</Badge> : null}
                <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  {t('rules.versions.effective', {
                    from: entry.version.effectiveFrom,
                    to: entry.version.effectiveTo ?? t('rules.versions.openEnded'),
                  })}
                </span>
              </div>
              {entry.version.definitionHash ? (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {t('rules.versions.hash', { hash: entry.version.definitionHash.slice(0, 12) })}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {entry.version.status === 'draft' ? (
                  <Button type="button" size="sm" disabled={busy} onClick={() => void publish(entry)}>
                    {t('rules.versions.publish')}
                  </Button>
                ) : null}
                {entry.version.status === 'published' ? (
                  retiring === entry.version.id ? (
                    <span className="flex flex-1 items-center gap-2">
                      <Input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder={t('rules.versions.retireReasonLabel')}
                        aria-label={t('rules.versions.retireReasonLabel')}
                      />
                      <Button type="button" size="sm" disabled={busy} onClick={() => void retire(entry)}>
                        {t('rules.versions.retire')}
                      </Button>
                    </span>
                  ) : (
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setRetiring(entry.version.id); setReason(''); setError(null) }}>
                      {t('rules.versions.retire')}
                    </Button>
                  )
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Button type="button" variant="outline" disabled={busy} onClick={() => void createVersion()}>
        {t('rules.versions.newVersion')}
      </Button>
    </div>
  )
}

interface TestPreviewRow {
  sequence: number
  label: string | null
  targetAccountId: string | null
  sharePercent: string | null
  isRemainder: boolean
}

/** Test tab: match a sample line (entry/post) or deep-link a period sweep. */
function TestTab({
  ruleId,
  detail,
  options,
}: {
  ruleId: string
  detail: RuleDetail
  options: PickerOptions
}) {
  const t = useTranslations('allocations')
  const [versionId, setVersionId] = useState(
    (detail.rule as { currentVersionId?: string | null }).currentVersionId
      ?? detail.versions.find((entry) => entry.version.status === 'published')?.version.id
      ?? detail.versions[0]?.version.id
      ?? '',
  )
  const [accountId, setAccountId] = useState('')
  const [documentKind, setDocumentKind] = useState('')
  const [dims, setDims] = useState<Record<string, string>>({})
  const [periodId, setPeriodId] = useState(options.periods[0]?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [verdict, setVerdict] = useState<{ matched: boolean; specificity: number } | null>(null)
  const [preview, setPreview] = useState<TestPreviewRow[]>([])
  const [basisNote, setBasisNote] = useState<string | null>(null)
  const [runsUrl, setRunsUrl] = useState<string | null>(null)
  const isPeriod = detail.rule.mode === 'period'
  const accountOptions = options.accounts.map((account) => ({ value: account.id, label: account.label }))
  const dimSources: { key: string; label: string; values: Option[] }[] = [
    { key: 'departmentId', label: t('rules.test.department'), values: options.departments },
    { key: 'locationId', label: t('rules.test.location'), values: options.locations },
    { key: 'classId', label: t('rules.test.class'), values: options.classes },
    { key: 'projectId', label: t('rules.test.project'), values: options.projects },
    { key: 'subsidiaryId', label: t('rules.test.subsidiary'), values: options.subsidiaries },
  ]

  const run = async () => {
    setTesting(true)
    setError(null)
    setVerdict(null)
    setPreview([])
    setBasisNote(null)
    setRunsUrl(null)
    const { status, body } = await fetchJson(`/api/allocations/rules/${encodeURIComponent(ruleId)}/test-match`, {
      method: 'POST',
      body: JSON.stringify(
        isPeriod
          ? { versionId: versionId === '' ? undefined : versionId, periodId }
          : { versionId: versionId === '' ? undefined : versionId, line: testLinePayload({ accountId, documentKind, dims }) },
      ),
    })
    setTesting(false)
    if (status !== 200) {
      setError(apiError(status, body, t('rules.errors.load')).message)
      return
    }
    const payload = body as {
      kind?: string
      runsUrl?: string
      matched?: boolean
      specificity?: number
      preview?: TestPreviewRow[]
      basisNote?: string | null
    }
    if (payload.kind === 'period' && typeof payload.runsUrl === 'string') {
      setRunsUrl(payload.runsUrl)
      return
    }
    setVerdict({ matched: payload.matched === true, specificity: Number(payload.specificity ?? 0) })
    setPreview(payload.preview ?? [])
    setBasisNote(payload.basisNote ?? null)
  }

  if (detail.versions.length === 0) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">{t('rules.test.noVersion')}</p>
  }

  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">{t('rules.test.heading')}</h2>
      {error ? <ErrorBox message={error} /> : null}
      <Field label={t('rules.test.version')}>
        <Select value={versionId} onChange={(e) => setVersionId(e.target.value)}>
          {detail.versions.map((entry) => (
            <option key={entry.version.id} value={entry.version.id}>
              {t('rules.versions.version', { n: entry.version.versionNo })} · {entry.version.status}
            </option>
          ))}
        </Select>
      </Field>
      {isPeriod ? (
        <>
          <h3 className="text-sm font-semibold">{t('rules.test.periodHeading')}</h3>
          <Field label={t('rules.test.period')}>
            <SearchSelect
              value={periodId}
              onChange={(value) => setPeriodId(value ?? '')}
              options={options.periods.map((period) => ({ value: period.id, label: period.label }))}
            />
          </Field>
          <Button type="button" onClick={() => void run()} disabled={testing || periodId === ''}>
            {testing ? t('rules.test.testing') : t('rules.test.run')}
          </Button>
          {runsUrl ? (
            <a className="text-sm font-medium text-teal-700 underline dark:text-teal-300" href={runsUrl as never}>
              {t('rules.test.openRuns')}
            </a>
          ) : null}
        </>
      ) : (
        <>
          <h3 className="text-sm font-semibold">{t('rules.test.lineHeading')}</h3>
          <Field label={t('rules.test.account')}>
            <SearchSelect value={accountId} onChange={(value) => setAccountId(value ?? '')} options={accountOptions} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('rules.test.documentKind')}>
              <Input value={documentKind} onChange={(e) => setDocumentKind(e.target.value)} />
            </Field>
            {dimSources.map((dim) => (
              <Field key={dim.key} label={dim.label}>
                <SearchSelect
                  value={dims[dim.key] ?? ''}
                  onChange={(value) =>
                    setDims((prev) => {
                      const next = { ...prev }
                      if (value === '' || value === null) delete next[dim.key]
                      else next[dim.key] = value
                      return next
                    })
                  }
                  options={dim.values.map((item) => ({ value: item.id, label: item.label }))}
                />
              </Field>
            ))}
          </div>
          <Button type="button" onClick={() => void run()} disabled={testing || accountId === ''}>
            {testing ? t('rules.test.testing') : t('rules.test.run')}
          </Button>
          {verdict ? (
            <p className="text-sm font-medium">
              {verdict.matched ? t('rules.test.matched', { n: verdict.specificity }) : t('rules.test.notMatched')}
            </p>
          ) : null}
          {basisNote ? <p className="text-xs text-slate-500 dark:text-slate-400">{basisNote}</p> : null}
          {preview.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                    <th className="py-1 pr-3 font-medium">{t('rules.test.targetColumn')}</th>
                    <th className="py-1 text-right font-medium">{t('rules.test.shareColumn')}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row) => (
                    <tr key={row.sequence} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-1 pr-3">{row.label ?? row.targetAccountId ?? ''}</td>
                      <td className="py-1 text-right tabular-nums">{row.sharePercent ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
