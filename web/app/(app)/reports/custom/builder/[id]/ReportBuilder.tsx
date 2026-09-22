'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowUpDown, Columns3, Database, Filter, ListTree, Play, Settings2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Label, SearchSelect, Select, cn } from '@openbooks/ui'
import {
  REPORT_ENTITIES,
  type ReportEntity,
  defaultColumnsFor,
  resolveReportLayout,
  type ReportCustomQuery,
  type ReportLayoutConfig,
  type ReportRunResult,
} from '@openbooks/reports'
import { DetailPageLayout } from '../../../../../../components/page-layout'
import { confirmDialog } from '../../../../../../lib/confirm'
import { FilterTree } from '../../FilterTree'
import { PaperView, type PaperData } from '../../../PaperView'
import { RowsConfig, SortConfig, SummarizeConfig } from '../../../query-config'
import { availableReportEntities } from '../../../../../../lib/report-builder-catalog'

type Tab = 'source' | 'columns' | 'grouping' | 'sorting' | 'filter' | 'format'

export function ReportBuilder({
  definition,
  company,
  customEntities = [],
  hiddenEntityKeys = [],
  inventoryEnabled,
  createMode = false,
}: {
  definition: {
    id: string
    kind: 'built_in' | 'custom'
    name: string
    description: string | null
    query: ReportCustomQuery
    layout?: Record<string, unknown> | null
  }
  company: string
  /** Entities the user lacks permission for (e.g. payroll wages) — hidden from the picker. */
  customEntities?: ReportEntity[]
  hiddenEntityKeys?: string[]
  inventoryEnabled: boolean
  /** `builder/new`: local-only until the operator explicitly saves. */
  createMode?: boolean
}) {
  const entities = useMemo(() => [...REPORT_ENTITIES, ...customEntities], [customEntities])
  const entityMap = useMemo(() => Object.fromEntries(entities.map(e => [e.key,e])), [entities])
  const visibleEntities = useMemo(
    () => availableReportEntities(entities, hiddenEntityKeys),
    [entities, hiddenEntityKeys],
  )
  const t = useTranslations('reports.custom.builder')
  const tk = useTranslations('reports.custom')
  const ta = useTranslations('reports.custom.actions')
  const tc = useTranslations('common')
  const tReports = useTranslations('reports')
  const router = useRouter()
  const [name, setName] = useState(definition.name)
  const [description, setDescription] = useState(definition.description ?? '')
  const [query, setQuery] = useState<ReportCustomQuery>(definition.query)
  const [layout, setLayout] = useState<ReportLayoutConfig>(
    resolveReportLayout(definition.layout as Partial<ReportLayoutConfig> | null | undefined),
  )
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>(createMode ? 'dirty' : 'saved')
  const [preview, setPreview] = useState<ReportRunResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [tab, setTab] = useState<Tab>('source')

  // PATCH requests can outlive the debounce timer that created them. Keep an
  // exact server revision and serialize saves so a late response can never
  // overwrite a newer definition (or report stale work as saved).
  const revisionRef = useRef<string | null>(null)
  const revisionRequestRef = useRef<Promise<string | null> | null>(null)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const saveGenerationRef = useRef(0)
  const createRequestIdRef = useRef<string | null>(null)
  const createInFlightRef = useRef(false)

  const ensureRevision = useCallback(async (): Promise<string | null> => {
    if (createMode) return null
    if (revisionRef.current) return revisionRef.current
    if (!revisionRequestRef.current) {
      const request = fetch(`/api/reports/definitions/${definition.id}`)
        .then(async (res) => {
          if (!res.ok) return null
          const data = (await res.json()) as { definition?: { updated_at?: unknown } }
          const revision = data.definition?.updated_at
          return typeof revision === 'string' ? revision : null
        })
        .catch(() => null)
      revisionRequestRef.current = request
    }
    const revision = await revisionRequestRef.current
    if (!revision) revisionRequestRef.current = null
    revisionRef.current = revision
    return revision
  }, [createMode, definition.id])

  const entity = entityMap[query.entity] ?? entityMap.ledger_lines!
  const mode = query.mode ?? 'rows'

  const patch = useCallback((next: Partial<ReportCustomQuery>) => {
    setQuery((q) => ({ ...q, ...next }))
  }, [])

  // -- entity change resets column/breakout/measure/sort selections ----------
  function changeEntity(key: string) {
    const e = entityMap[key]
    if (!e) return
    setQuery({
      entity: key,
      mode,
      columns: defaultColumnsFor(e),
      breakouts: [],
      measures: [{ fn: 'count' }],
      filters: null,
      groupBy: null,
      sorts: e.defaultSort ? [e.defaultSort] : null,
      limit: query.limit ?? 1000,
    })
  }

  // -- live preview (debounced) ----------------------------------------------
  const runPreview = useCallback(
    async (plan: ReportCustomQuery) => {
      setPreviewing(true)
      const res = await fetch('/api/reports/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: plan }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setPreview(null)
        setPreviewError(data.error ?? t('previewFailed'))
        setPreviewing(false)
        return
      }
      const data = (await res.json()) as { result: ReportRunResult }
      setPreview(data.result)
      setPreviewError(null)
      setPreviewing(false)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const firstPreview = useRef(true)
  useEffect(() => {
    const timer = setTimeout(() => runPreview(query), firstPreview.current ? 0 : 500)
    firstPreview.current = false
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  // -- autosave (debounced PATCH) --------------------------------------------
  const firstSave = useRef(true)
  useEffect(() => {
    // The `new` sentinel has no database row. Its edits stay in memory until
    // the explicit Save POST below; opening and cancelling are zero-write.
    if (createMode) {
      firstSave.current = false
      return
    }
    if (firstSave.current) {
      firstSave.current = false
      return
    }
    const generation = ++saveGenerationRef.current
    setSaveState('dirty')
    const timer = setTimeout(async () => {
      const payload = { name, description, query, layout }
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          // A newer debounce superseded this payload before the queue reached
          // it. Skip the stale write entirely and let the latest generation
          // carry the current state to the server.
          if (generation !== saveGenerationRef.current) return
          const expectedUpdatedAt = await ensureRevision()
          // Editing while the revision GET was in flight supersedes this save.
          if (generation !== saveGenerationRef.current) return
          if (!expectedUpdatedAt) {
            setSaveState('error')
            toast.error(tc('feedback.saveFailed'))
            return
          }
          setSaveState('saving')
          try {
            const res = await fetch(`/api/reports/definitions/${definition.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...payload, expectedUpdatedAt }),
            })
            const data = (await res.json().catch(() => ({}))) as {
              error?: string
              definition?: { updated_at?: unknown }
            }
            if (res.ok) {
              const savedRevision = data.definition?.updated_at
              if (typeof savedRevision === 'string') revisionRef.current = savedRevision
              if (generation === saveGenerationRef.current) {
                setSaveState('saved')
                router.refresh()
              }
            } else if (generation === saveGenerationRef.current) {
              setSaveState('error')
              toast.error(data.error ?? tc('feedback.saveFailed'))
            }
          } catch {
            if (generation !== saveGenerationRef.current) return
            setSaveState('error')
            toast.error(tc('feedback.saveFailed'))
          }
        })
    }, 700)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, description, query, layout, ensureRevision, createMode])

  async function createReport() {
    if (!createMode || createInFlightRef.current) return
    createInFlightRef.current = true
    setCreating(true)
    if (!createRequestIdRef.current) createRequestIdRef.current = crypto.randomUUID()
    try {
      const res = await fetch('/api/reports/definitions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': createRequestIdRef.current,
        },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), query, layout }),
      })
      if (!res.ok) {
        const failure = (await res.json().catch(() => ({}))) as { error?: unknown }
        toast.error(
          typeof failure.error === 'string' && failure.error
            ? failure.error
            : tk('newButton.createFailed'),
        )
        return
      }
      const data = (await res.json()) as { definition?: { id?: unknown } }
      const id = data.definition?.id
      if (typeof id !== 'string' || !id) {
        toast.error(tk('newButton.createFailed'))
        return
      }
      toast.success(t('allChangesSaved'))
      router.replace(`/reports/custom/builder/${id}`)
      router.refresh()
    } catch {
      toast.error(tk('newButton.createFailed'))
    } finally {
      createInFlightRef.current = false
      setCreating(false)
    }
  }

  async function removeReport() {
    const confirmed = await confirmDialog({
      message: ta('deleteConfirm'),
      tone: 'danger',
    })
    if (!confirmed) return

    setDeleting(true)
    const res = await fetch(`/api/reports/definitions/${definition.id}`, {
      method: 'DELETE',
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(data.error ?? ta('deleteFailed'))
      setDeleting(false)
      return
    }

    toast.success(ta('deleted'))
    router.push('/reports/custom')
    router.refresh()
  }

  // ReportRunResult → the unified PaperView shape (same contract statements use).
  const paper: PaperData | null = preview
    ? {
        title: name || t('namePlaceholder'),
        periodPhrase: description || undefined,
        ...(createMode
          ? {}
          : { defaultDrillTarget: { kind: 'custom' as const, source: 'definition' as const, id: definition.id, label: name || t('namePlaceholder') } }),
        summary: preview.summary,
        groups: preview.groups.map((g) => ({
          title: g.title,
          subtitle: g.subtitle,
          columns: g.columns,
          rows: g.rows,
          isEmpty: g.isEmpty,
        })),
      }
    : null

  const field = 'space-y-1.5'
  const sourceGroupLabel = (category: string) => {
    const normalized = category.toLocaleLowerCase()
    if (normalized === 'general_ledger') return tReports('hub.groups.ledger')
    if (normalized === 'transactions') return tReports('hub.groups.receivablesPayables')
    if (normalized === 'inventory') return tReports('hub.groups.inventory')
    if (normalized === 'payroll') return tReports('hub.groups.payroll')
    if (normalized === 'hrm') return tReports('hub.groups.hrm')
    if (normalized === 'crm') return tReports('hub.groups.crm')
    if (normalized === 'ai governance') return tReports('hub.groups.aiGovernance')
    if (normalized === 'catalog') return tReports('hub.groups.custom')
    return category.replaceAll('_', ' ').replace(/^./, (letter) => letter.toLocaleUpperCase())
  }
  const entityLabel = (candidate: ReportEntity) => (
    candidate.key.startsWith('custom:') ? candidate.label : tReports(`catalog.entities.${candidate.key}.label`)
  )
  const entityDescription = (candidate: ReportEntity) => (
    candidate.key.startsWith('custom:') ? candidate.description : tReports(`catalog.entities.${candidate.key}.description`)
  )
  const sourceOptions = visibleEntities.map((candidate) => ({
    value: candidate.key,
    label: entityLabel(candidate),
    hint: entityDescription(candidate),
    group: sourceGroupLabel(candidate.category),
  }))
  const tabs: { key: Tab; label: string; icon: typeof Database }[] = [
    { key: 'source', label: t('tabs.source'), icon: Database },
    { key: 'columns', label: t('tabs.columns'), icon: Columns3 },
    { key: 'grouping', label: t('tabs.grouping'), icon: ListTree },
    { key: 'sorting', label: t('tabs.sorting'), icon: ArrowUpDown },
    { key: 'filter', label: t('tabs.filter'), icon: Filter },
    { key: 'format', label: t('tabs.format'), icon: Settings2 },
  ]

  return (
    <DetailPageLayout
      header={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-nowrap">
            <Input
              className="h-9 w-full text-base font-semibold sm:w-64 sm:shrink-0"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
            />
            {definition.kind === 'built_in' ? <Badge className="shrink-0" variant="secondary">{tk('kind.builtIn')}</Badge> : null}
            <Input
              className="h-9 min-w-56 flex-1 text-sm"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('descriptionPlaceholder')}
            />
          </div>
          <div className="flex items-center gap-3">
            {createMode ? (
              <>
                <span className="text-xs text-slate-500 dark:text-slate-400">{t('unsavedChanges')}</span>
                <Button type="button" variant="outline" disabled={creating} onClick={() => router.push('/reports/custom')}>
                  {tc('actions.cancel')}
                </Button>
                <Button type="button" disabled={creating || !name.trim()} onClick={createReport}>
                  {creating ? tc('actions.saving') : tc('actions.save')}
                </Button>
              </>
            ) : (
              <>
                <span
                  className={
                    'text-xs ' + (saveState === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')
                  }
                >
                  {saveState === 'saved'
                    ? t('allChangesSaved')
                    : saveState === 'saving'
                      ? tc('actions.saving')
                      : saveState === 'error'
                        ? tc('feedback.saveFailed')
                        : t('unsavedChanges')}
                </span>
                <Button variant="outline" asChild>
                  <Link href={`/reports/custom/run/${definition.id}`}>{t('runAndSchedule')}</Link>
                </Button>
                {definition.kind === 'custom' ? (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={deleting}
                    onClick={removeReport}
                  >
                    <Trash2 size={14} />
                    {deleting ? tc('actions.deleting') : tc('actions.delete')}
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </div>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(360px,1fr)_2fr]">
        {/* --- control panel (1/3) with subtabs --- */}
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-0.5 rounded-lg border border-slate-200 p-0.5 dark:border-slate-800">
            {tabs.map((tb) => {
              const Icon = tb.icon
              return (
                <button
                  key={tb.key}
                  type="button"
                  onClick={() => setTab(tb.key)}
                  aria-pressed={tab === tb.key}
                  className={cn(
                    'flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors sm:text-sm',
                    tab === tb.key
                      ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                      : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100',
                  )}
                >
                  <Icon size={14} /> {tb.label}
                </button>
              )
            })}
          </div>

          {tab === 'source' ? (
            <div className="space-y-5">
              <div className={field}>
                <Label>{t('source')}</Label>
                <SearchSelect
                  value={query.entity}
                  onChange={changeEntity}
                  options={sourceOptions}
                  searchable
                  searchPlaceholder={t('sourceSearchPlaceholder')}
                  sheetTitle={t('source')}
                  ariaLabel={t('source')}
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">{entityDescription(entity)}</p>
              </div>

              <div className={field}>
                <Label>{t('mode')}</Label>
                <div className="flex gap-2">
                  <Button type="button" variant={mode === 'rows' ? 'default' : 'outline'} size="sm" onClick={() => patch({ mode: 'rows' })}>
                    {t('detailRows')}
                  </Button>
                  <Button
                    type="button"
                    variant={mode === 'summarize' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => patch({ mode: 'summarize', measures: query.measures?.length ? query.measures : [{ fn: 'count' }] })}
                  >
                    {t('summarize')}
                  </Button>
                </div>
              </div>

              <div className={field}>
                <Label>{t('rowLimit')}</Label>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={query.limit ?? 1000}
                  onChange={(event) => {
                    const requested = Number(event.target.value)
                    patch({
                      limit: Number.isFinite(requested)
                        ? Math.min(Math.max(Math.trunc(requested), 1), Number.MAX_SAFE_INTEGER)
                        : 1,
                    })
                  }}
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('rowLimitHint', { previewRows: 200 })}</p>
              </div>
            </div>
          ) : tab === 'columns' ? (
            mode === 'rows' ? (
              <RowsConfig entity={entity} query={query} patch={patch} columns={entity.columns} section="columns" />
            ) : (
              <SummarizeConfig entity={entity} query={query} patch={patch} section="measures" />
            )
          ) : tab === 'grouping' ? (
            mode === 'rows' ? (
              <RowsConfig entity={entity} query={query} patch={patch} columns={entity.columns} section="grouping" />
            ) : (
              <SummarizeConfig entity={entity} query={query} patch={patch} section="grouping" />
            )
          ) : tab === 'sorting' ? (
            <SortConfig entity={entity} query={query} patch={patch} />
          ) : tab === 'filter' ? (
            <div className={field}>
              <Label>{tc('labels.filters')}</Label>
              <FilterTree
                entity={entity}
                inventoryEnabled={inventoryEnabled}
                group={query.filters ?? { combinator: 'and', rules: [] }}
                onChange={(g) => patch({ filters: g.rules.length ? g : null })}
              />
            </div>
          ) : (
            <div className={field}>
              <Label>{t('pageSetup.title')}</Label>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('pageSetup.hint')}</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">{t('pageSetup.paper')}</Label>
                  <Select value={layout.paperSize} onChange={(e) => setLayout((l) => ({ ...l, paperSize: e.target.value as ReportLayoutConfig['paperSize'] }))}>
                    <option value="letter">{t('pageSetup.paperLetter')}</option>
                    <option value="a4">{t('pageSetup.paperA4')}</option>
                    <option value="legal">{t('pageSetup.paperLegal')}</option>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">{t('pageSetup.orientation')}</Label>
                  <Select value={layout.orientation} onChange={(e) => setLayout((l) => ({ ...l, orientation: e.target.value as 'portrait' | 'landscape' }))}>
                    <option value="landscape">{t('pageSetup.landscape')}</option>
                    <option value="portrait">{t('pageSetup.portrait')}</option>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">{t('pageSetup.density')}</Label>
                  <Select value={layout.density} onChange={(e) => setLayout((l) => ({ ...l, density: e.target.value as ReportLayoutConfig['density'] }))}>
                    <option value="standard">{t('pageSetup.densityStandard')}</option>
                    <option value="compact">{t('pageSetup.densityCompact')}</option>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">{t('pageSetup.marginMm')}</Label>
                  <Input
                    type="number"
                    min={5}
                    max={30}
                    value={layout.marginMm}
                    onChange={(e) => setLayout((l) => ({ ...l, marginMm: Math.min(Math.max(Number(e.target.value) || 15, 5), 30) }))}
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 accent-teal-600"
                  checked={layout.showSummary !== false}
                  onChange={(event) => setLayout((current) => ({ ...current, showSummary: event.currentTarget.checked }))}
                />
                {t('pageSetup.showSummary')}
              </label>
            </div>
          )}
        </div>

        {/* --- live paper preview (2/3) --- */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('livePreview')}</h2>
            <Button variant="outline" size="sm" disabled={previewing} onClick={() => runPreview(query)}>
              <Play size={14} /> {previewing ? tk('running') : tc('actions.refresh')}
            </Button>
          </div>
          {previewError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
              {previewError}
            </div>
          ) : paper ? (
            <div className="rounded-xl bg-slate-100/70 p-4 sm:p-6 dark:bg-slate-950/40">
              <PaperView company={company} data={paper} emptyLabel={tk('resultView.noRows')} />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
              {previewing ? t('runningPreview') : t('previewEmptyHint')}
            </div>
          )}
        </div>
      </div>
    </DetailPageLayout>
  )
}

// RowsConfig + SummarizeConfig live in ../../../query-config and are shared with
// the view builder.
