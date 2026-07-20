'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Filter, Play, Settings2, Table2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Label, Select, cn } from '@openbooks/ui'
import {
  REPORT_ENTITIES,
  REPORT_ENTITY_MAP,
  defaultColumnsFor,
  isOperationalColumn,
  resolveReportLayout,
  type ReportCustomQuery,
  type ReportLayoutConfig,
  type ReportRunResult,
} from '@openbooks/reports'
import { DetailPageLayout } from '../../../../../../components/page-layout'
import { FilterTree } from '../../FilterTree'
import { PaperView, type PaperData } from '../../../PaperView'
import { RowsConfig, SummarizeConfig } from '../../../query-config'

type Tab = 'data' | 'filter' | 'format'

export function ReportBuilder({
  definition,
  company,
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
}) {
  const t = useTranslations('reports.custom.builder')
  const tk = useTranslations('reports.custom')
  const tc = useTranslations('common')
  const tReports = useTranslations('reports')
  const router = useRouter()
  const [name, setName] = useState(definition.name)
  const [description, setDescription] = useState(definition.description ?? '')
  const [query, setQuery] = useState<ReportCustomQuery>(definition.query)
  const [layout, setLayout] = useState<ReportLayoutConfig>(
    resolveReportLayout(definition.layout as Partial<ReportLayoutConfig> | null | undefined),
  )
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [preview, setPreview] = useState<ReportRunResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [tab, setTab] = useState<Tab>('data')

  const entity = REPORT_ENTITY_MAP[query.entity] ?? REPORT_ENTITY_MAP.ledger_lines!
  const mode = query.mode ?? 'rows'

  const patch = useCallback((next: Partial<ReportCustomQuery>) => {
    setQuery((q) => ({ ...q, ...next }))
  }, [])

  // -- entity change resets column/breakout/measure/sort selections ----------
  function changeEntity(key: string) {
    const e = REPORT_ENTITY_MAP[key]
    if (!e) return
    setQuery({
      entity: key,
      mode,
      columns: defaultColumnsFor(e),
      breakouts: [],
      measures: [{ fn: 'count' }],
      filters: null,
      groupBy: null,
      sort: e.defaultSort ?? null,
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
      const data = await res.json()
      if (res.ok) {
        setPreview(data.result)
        setPreviewError(null)
      } else {
        setPreview(null)
        setPreviewError(data.error ?? t('previewFailed'))
      }
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
    if (firstSave.current) {
      firstSave.current = false
      return
    }
    setSaveState('dirty')
    const timer = setTimeout(async () => {
      setSaveState('saving')
      const res = await fetch(`/api/reports/definitions/${definition.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, query, layout }),
      })
      if (res.ok) {
        setSaveState('saved')
        router.refresh()
      } else {
        setSaveState('error')
        toast.error((await res.json()).error ?? tc('feedback.saveFailed'))
      }
    }, 700)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, description, query, layout])

  const selectableColumns = useMemo(() => entity.columns.filter(isOperationalColumn), [entity])

  // ReportRunResult → the unified PaperView shape (same contract statements use).
  const paper: PaperData | null = preview
    ? {
        title: name || t('namePlaceholder'),
        periodPhrase: description || undefined,
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
  const tabs: { key: Tab; label: string; icon: typeof Table2 }[] = [
    { key: 'data', label: t('tabs.data'), icon: Table2 },
    { key: 'filter', label: t('tabs.filter'), icon: Filter },
    { key: 'format', label: t('tabs.format'), icon: Settings2 },
  ]

  return (
    <DetailPageLayout
      header={
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <Input
                className="h-9 w-72 text-base font-semibold"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('namePlaceholder')}
              />
              {definition.kind === 'built_in' ? <Badge variant="secondary">{tk('kind.builtIn')}</Badge> : null}
            </div>
            <Input
              className="h-8 w-full max-w-xl text-sm"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('descriptionPlaceholder')}
            />
          </div>
          <div className="flex items-center gap-3">
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
          </div>
        </div>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(320px,1fr)_2fr]">
        {/* --- control panel (1/3) with subtabs --- */}
        <div className="space-y-4">
          <div className="inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-800">
            {tabs.map((tb) => {
              const Icon = tb.icon
              return (
                <button
                  key={tb.key}
                  type="button"
                  onClick={() => setTab(tb.key)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
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

          {tab === 'data' ? (
            <div className="space-y-5">
              <div className={field}>
                <Label>{t('source')}</Label>
                <Select value={query.entity} onChange={(e) => changeEntity(e.target.value)}>
                  {REPORT_ENTITIES.map((e) => (
                    <option key={e.key} value={e.key}>
                      {tReports(`catalog.entities.${e.key}.label`)}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-slate-500 dark:text-slate-400">{tReports(`catalog.entities.${entity.key}.description`)}</p>
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

              {mode === 'rows' ? (
                <RowsConfig entity={entity} query={query} patch={patch} columns={selectableColumns} />
              ) : (
                <SummarizeConfig entity={entity} query={query} patch={patch} />
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className={field}>
                  <Label>{t('sortBy')}</Label>
                  <Select
                    value={query.sort?.column ?? ''}
                    onChange={(e) =>
                      patch({ sort: e.target.value ? { column: e.target.value, direction: query.sort?.direction ?? 'desc' } : null })
                    }
                  >
                    <option value="">{t('sortDefault')}</option>
                    {entity.columns.map((c) => (
                      <option key={c.key} value={c.key}>
                        {tReports(`catalog.columns.${entity.key}.${c.key}`)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className={field}>
                  <Label>{t('direction')}</Label>
                  <Select
                    value={query.sort?.direction ?? 'desc'}
                    disabled={!query.sort?.column}
                    onChange={(e) => query.sort?.column && patch({ sort: { column: query.sort.column, direction: e.target.value as 'asc' | 'desc' } })}
                  >
                    <option value="desc">{t('descending')}</option>
                    <option value="asc">{t('ascending')}</option>
                  </Select>
                </div>
              </div>

              <div className={field}>
                <Label>{t('rowLimit')}</Label>
                <Input
                  type="number"
                  min={1}
                  max={10000}
                  value={query.limit ?? 1000}
                  onChange={(e) => patch({ limit: Math.min(Math.max(Number(e.target.value) || 1, 1), 10000) })}
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('rowLimitHint', { previewRows: 200 })}</p>
              </div>
            </div>
          ) : tab === 'filter' ? (
            <div className={field}>
              <Label>{tc('labels.filters')}</Label>
              <FilterTree
                entity={entity}
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
