'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Play, Trash2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Label, Select } from '@openbooks/ui'
import {
  REPORT_AGG_FNS,
  REPORT_ENTITIES,
  REPORT_ENTITY_MAP,
  REPORT_TEMPORAL_BINS,
  defaultColumnsFor,
  isOperationalColumn,
  type ReportAggFn,
  type ReportBreakout,
  type ReportCustomQuery,
  type ReportEntity,
  type ReportMeasure,
  type ReportRuleGroup,
  type ReportRunResult,
  type ReportTemporalBin,
} from '@openbooks/reports'
import { DetailPageLayout } from '../../../../../../components/page-layout'
import { FilterTree } from '../../FilterTree'
import { ResultView } from '../../ResultView'

// Message keys under reports.custom.builder.agg — translated at render.
const AGG_LABEL_KEY: Record<ReportAggFn, string> = {
  count: 'agg.count',
  count_distinct: 'agg.countDistinct',
  sum: 'agg.sum',
  avg: 'agg.avg',
  min: 'agg.min',
  max: 'agg.max',
}

/** Columns that can be temporally binned (date/timestamp). */
function isTemporal(entity: ReportEntity, key: string): boolean {
  const kind = entity.columns.find((c) => c.key === key)?.kind
  return kind === 'date' || kind === 'timestamp'
}

/** Columns valid as an aggregate target for a given fn (numbers for sum/avg). */
function measureColumns(entity: ReportEntity, fn: ReportAggFn) {
  if (fn === 'sum' || fn === 'avg') return entity.columns.filter((c) => c.kind === 'number')
  return entity.columns.filter((c) => c.kind !== 'uuid')
}

export function ReportBuilder({
  definition,
}: {
  definition: {
    id: string
    kind: 'built_in' | 'custom'
    name: string
    description: string | null
    query: ReportCustomQuery
  }
}) {
  const t = useTranslations('reports.custom.builder')
  const tk = useTranslations('reports.custom')
  const tc = useTranslations('common')
  const router = useRouter()
  const [name, setName] = useState(definition.name)
  const [description, setDescription] = useState(definition.description ?? '')
  const [query, setQuery] = useState<ReportCustomQuery>(definition.query)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [preview, setPreview] = useState<ReportRunResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)

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
        body: JSON.stringify({ name, description, query }),
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
  }, [name, description, query])

  const selectableColumns = useMemo(
    () => entity.columns.filter(isOperationalColumn),
    [entity],
  )

  const field = 'space-y-1.5'

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
                'text-xs ' +
                (saveState === 'error'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-slate-500 dark:text-slate-400')
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
      <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_1fr]">
        {/* --- configuration panel --- */}
        <div className="space-y-5">
          <div className={field}>
            <Label>{t('source')}</Label>
            <Select value={query.entity} onChange={(e) => changeEntity(e.target.value)}>
              {REPORT_ENTITIES.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.label}
                </option>
              ))}
            </Select>
            <p className="text-xs text-slate-500 dark:text-slate-400">{entity.description}</p>
          </div>

          <div className={field}>
            <Label>{t('mode')}</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={mode === 'rows' ? 'default' : 'outline'}
                size="sm"
                onClick={() => patch({ mode: 'rows' })}
              >
                {t('detailRows')}
              </Button>
              <Button
                type="button"
                variant={mode === 'summarize' ? 'default' : 'outline'}
                size="sm"
                onClick={() =>
                  patch({
                    mode: 'summarize',
                    measures: query.measures?.length ? query.measures : [{ fn: 'count' }],
                  })
                }
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

          <div className={field}>
            <Label>{tc('labels.filters')}</Label>
            <FilterTree
              entity={entity}
              group={query.filters ?? { combinator: 'and', rules: [] }}
              onChange={(g) => patch({ filters: g.rules.length ? g : null })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className={field}>
              <Label>{t('sortBy')}</Label>
              <Select
                value={query.sort?.column ?? ''}
                onChange={(e) =>
                  patch({
                    sort: e.target.value
                      ? { column: e.target.value, direction: query.sort?.direction ?? 'desc' }
                      : null,
                  })
                }
              >
                <option value="">{t('sortDefault')}</option>
                {entity.columns.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className={field}>
              <Label>{t('direction')}</Label>
              <Select
                value={query.sort?.direction ?? 'desc'}
                disabled={!query.sort?.column}
                onChange={(e) =>
                  query.sort?.column &&
                  patch({ sort: { column: query.sort.column, direction: e.target.value as 'asc' | 'desc' } })
                }
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
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('rowLimitHint', { previewRows: 200 })}
            </p>
          </div>
        </div>

        {/* --- live preview --- */}
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
          ) : preview ? (
            <ResultView result={preview} />
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

// --- rows-mode column picker -------------------------------------------------

function RowsConfig({
  entity,
  query,
  patch,
  columns,
}: {
  entity: ReportEntity
  query: ReportCustomQuery
  patch: (n: Partial<ReportCustomQuery>) => void
  columns: ReportEntity['columns']
}) {
  const t = useTranslations('reports.custom.builder')
  const selected = query.columns ?? []
  const toggle = (key: string) => {
    const next = selected.includes(key) ? selected.filter((c) => c !== key) : [...selected, key]
    patch({ columns: next })
  }
  return (
    <>
      <div className="space-y-1.5">
        <Label>{t('columns')}</Label>
        <div className="flex flex-wrap gap-1.5">
          {columns.map((c) => {
            const on = selected.includes(c.key)
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => toggle(c.key)}
                className={
                  'rounded-full border px-2.5 py-1 text-xs transition-colors ' +
                  (on
                    ? 'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-500 dark:bg-teal-950/40 dark:text-teal-300'
                    : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300')
                }
              >
                {c.label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>{t('sectionBy')}</Label>
        <Select
          value={query.groupBy ?? ''}
          onChange={(e) => patch({ groupBy: e.target.value || null })}
        >
          <option value="">{t('noSections')}</option>
          {entity.columns.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </Select>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t('sectionByHint')}
        </p>
      </div>
    </>
  )
}

// --- summarize-mode breakouts + measures ------------------------------------

function SummarizeConfig({
  entity,
  query,
  patch,
}: {
  entity: ReportEntity
  query: ReportCustomQuery
  patch: (n: Partial<ReportCustomQuery>) => void
}) {
  const t = useTranslations('reports.custom.builder')
  const tc = useTranslations('common')
  const breakouts = query.breakouts ?? []
  const measures = query.measures ?? []

  const setBreakout = (i: number, b: ReportBreakout) => {
    const next = [...breakouts]
    next[i] = b
    patch({ breakouts: next })
  }
  const setMeasure = (i: number, m: ReportMeasure) => {
    const next = [...measures]
    next[i] = m
    patch({ measures: next })
  }

  return (
    <>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>{t('groupBy')}</Label>
          {breakouts.length < 6 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                patch({ breakouts: [...breakouts, { column: entity.columns[0]?.key ?? '' }] })
              }
            >
              <Plus size={14} /> {tc('actions.add')}
            </Button>
          ) : null}
        </div>
        {breakouts.length === 0 ? (
          <p className="text-xs text-slate-400 dark:text-slate-500">
            {t('noGroupsHint')}
          </p>
        ) : null}
        {breakouts.map((b, i) => {
          const temporal = isTemporal(entity, b.column)
          return (
            <div key={i} className="flex items-center gap-2">
              <Select
                className="h-8 flex-1"
                value={b.column}
                onChange={(e) => {
                  const col = e.target.value
                  setBreakout(i, { column: col, ...(isTemporal(entity, col) && b.bin ? { bin: b.bin } : {}) })
                }}
              >
                {entity.columns.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </Select>
              {temporal ? (
                <Select
                  className="h-8 w-28"
                  value={b.bin ?? ''}
                  onChange={(e) =>
                    setBreakout(i, {
                      column: b.column,
                      ...(e.target.value ? { bin: e.target.value as ReportTemporalBin } : {}),
                    })
                  }
                >
                  <option value="">{t('noBin')}</option>
                  {REPORT_TEMPORAL_BINS.map((bin) => (
                    <option key={bin} value={bin}>
                      {t(`bin.${bin}`)}
                    </option>
                  ))}
                </Select>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => patch({ breakouts: breakouts.filter((_, j) => j !== i) })}
                aria-label={t('removeGroupAria')}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          )
        })}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>{t('measures')}</Label>
          {measures.length < 8 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => patch({ measures: [...measures, { fn: 'count' }] })}
            >
              <Plus size={14} /> {tc('actions.add')}
            </Button>
          ) : null}
        </div>
        {measures.map((m, i) => {
          const cols = measureColumns(entity, m.fn)
          return (
            <div key={i} className="flex items-center gap-2">
              <Select
                className="h-8 w-36"
                value={m.fn}
                onChange={(e) => {
                  const fn = e.target.value as ReportAggFn
                  const valid = measureColumns(entity, fn)
                  setMeasure(i, {
                    fn,
                    ...(fn === 'count'
                      ? {}
                      : { column: m.column && valid.some((c) => c.key === m.column) ? m.column : valid[0]?.key }),
                  })
                }}
              >
                {REPORT_AGG_FNS.map((fn) => (
                  <option key={fn} value={fn}>
                    {AGG_LABEL_KEY[fn] ? t(AGG_LABEL_KEY[fn]) : fn}
                  </option>
                ))}
              </Select>
              {m.fn !== 'count' ? (
                <Select
                  className="h-8 flex-1"
                  value={m.column ?? ''}
                  onChange={(e) => setMeasure(i, { ...m, column: e.target.value })}
                >
                  {cols.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  patch({ measures: measures.length > 1 ? measures.filter((_, j) => j !== i) : measures })
                }
                aria-label={t('removeMeasureAria')}
                disabled={measures.length <= 1}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          )
        })}
      </div>
    </>
  )
}
