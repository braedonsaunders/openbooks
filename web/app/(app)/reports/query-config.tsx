'use client'

import { ChevronDown, ChevronUp, Plus, Trash2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, Select } from '@openbooks/ui'
import {
  REPORT_AGG_FNS,
  REPORT_TEMPORAL_BINS,
  type ReportAggFn,
  type ReportBreakout,
  type ReportCustomQuery,
  type ReportEntity,
  type ReportMeasure,
  type ReportTemporalBin,
} from '@openbooks/reports'

/**
 * Shared query-config editors (rows-mode column picker, summarize-mode
 * breakouts + measures) reused by the custom-report builder AND the
 * view builder — one editing surface for the shared ReportCustomQuery
 * plan. Extracted verbatim from ReportBuilder so neither surface drifts.
 */

/** Columns that can be temporally binned (date/timestamp). */
export function isTemporal(entity: ReportEntity, key: string): boolean {
  const kind = entity.columns.find((c) => c.key === key)?.kind
  return kind === 'date' || kind === 'timestamp'
}

/** Columns valid as an aggregate target for a given fn (numbers for sum/avg). */
export function measureColumns(entity: ReportEntity, fn: ReportAggFn) {
  if (fn === 'sum' || fn === 'avg') return entity.columns.filter((c) => c.kind === 'number')
  return entity.columns.filter((c) => c.kind !== 'uuid')
}

export function RowsConfig({
  entity,
  query,
  patch,
  columns,
  disabled = false,
}: {
  entity: ReportEntity
  query: ReportCustomQuery
  patch: (n: Partial<ReportCustomQuery>) => void
  columns: ReportEntity['columns']
  disabled?: boolean
}) {
  const t = useTranslations('reports.custom.builder')
  const tReports = useTranslations('reports')
  const selected = query.columns ?? []
  const labels = query.columnLabels ?? {}
  const defaultLabel = (key: string) => tReports(`catalog.columns.${entity.key}.${key}`)

  const setColumns = (next: string[]) => {
    // Drop label overrides for columns no longer selected.
    const nextLabels = Object.fromEntries(Object.entries(labels).filter(([k]) => next.includes(k)))
    patch({ columns: next, columnLabels: Object.keys(nextLabels).length ? nextLabels : null })
  }
  const setLabel = (key: string, value: string) => {
    const next = { ...labels }
    if (value.trim()) next[key] = value
    else delete next[key]
    patch({ columnLabels: Object.keys(next).length ? next : null })
  }
  const move = (i: number, delta: -1 | 1) => {
    const j = i + delta
    if (j < 0 || j >= selected.length) return
    const next = [...selected]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    setColumns(next)
  }
  const available = columns.filter((c) => !selected.includes(c.key))

  return (
    <>
      <div className="space-y-1.5">
        <Label>{t('selectedColumns')}</Label>
        {selected.length === 0 ? (
          <p className="text-xs text-red-600 dark:text-red-400">{t('noColumnsSelected')}</p>
        ) : (
          <ul className="space-y-1">
            {selected.map((key, i) => (
              <li key={key} className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300">
                  {defaultLabel(key)}
                </span>
                <Input
                  className="h-7 w-32 text-xs"
                  value={labels[key] ?? ''}
                  onChange={(e) => setLabel(key, e.target.value)}
                  placeholder={t('labelOverridePlaceholder')}
                  disabled={disabled}
                />
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={disabled || i === 0}
                  aria-label={t('moveUpAria')}
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={disabled || i === selected.length - 1}
                  aria-label={t('moveDownAria')}
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                >
                  <ChevronDown size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => setColumns(selected.filter((c) => c !== key))}
                  disabled={disabled}
                  aria-label={t('removeColumnAria')}
                  className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {available.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {available.map((c) => (
              <button
                key={c.key}
                type="button"
                disabled={disabled}
                onClick={() => setColumns([...selected, c.key])}
                className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition-colors hover:border-teal-400 hover:text-teal-700 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:border-teal-500 dark:hover:text-teal-300"
              >
                <span className="inline-flex items-center gap-1"><Plus size={11} /> {defaultLabel(c.key)}</span>
              </button>
            ))}
          </div>
        ) : null}
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
              {tReports(`catalog.columns.${entity.key}.${c.key}`)}
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

/** Multi-level sort editor (maximum three levels). */
export function SortConfig({
  entity,
  query,
  patch,
  disabled = false,
}: {
  entity: ReportEntity
  query: ReportCustomQuery
  patch: (n: Partial<ReportCustomQuery>) => void
  disabled?: boolean
}) {
  const t = useTranslations('reports.custom.builder')
  const tReports = useTranslations('reports')
  const sorts = query.sorts ?? []

  const commit = (next: { column: string; direction: 'asc' | 'desc' }[]) => {
    const cleaned = next.filter((s) => s.column)
    patch({ sorts: cleaned.length ? cleaned : null })
  }
  const setLevel = (i: number, s: { column: string; direction: 'asc' | 'desc' }) => {
    const next = [...sorts]
    next[i] = s
    commit(next)
  }
  const usedColumns = new Set(sorts.map((s) => s.column))

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>{t('sortBy')}</Label>
        {sorts.length < 3 && sorts.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              const first = entity.columns.find((c) => !usedColumns.has(c.key))
              if (first) commit([...sorts, { column: first.key, direction: 'desc' }])
            }}
          >
            <Plus size={14} /> {t('addSortLevel')}
          </Button>
        ) : null}
      </div>
      {sorts.length === 0 ? (
        <Select
          value=""
          disabled={disabled}
          onChange={(e) => e.target.value && commit([{ column: e.target.value, direction: 'desc' }])}
        >
          <option value="">{t('sortDefault')}</option>
          {entity.columns.map((c) => (
            <option key={c.key} value={c.key}>
              {tReports(`catalog.columns.${entity.key}.${c.key}`)}
            </option>
          ))}
        </Select>
      ) : (
        sorts.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            {i > 0 ? (
              <span className="w-14 shrink-0 text-right text-[11px] text-slate-400 dark:text-slate-500">{t('thenBy')}</span>
            ) : null}
            <Select
              className="h-8 flex-1"
              value={s.column}
              disabled={disabled}
              onChange={(e) => setLevel(i, { column: e.target.value, direction: s.direction })}
            >
              {entity.columns.map((c) => (
                <option key={c.key} value={c.key} disabled={usedColumns.has(c.key) && c.key !== s.column}>
                  {tReports(`catalog.columns.${entity.key}.${c.key}`)}
                </option>
              ))}
            </Select>
            <Select
              className="h-8 w-32"
              value={s.direction}
              disabled={disabled}
              onChange={(e) => setLevel(i, { column: s.column, direction: e.target.value as 'asc' | 'desc' })}
            >
              <option value="desc">{t('descending')}</option>
              <option value="asc">{t('ascending')}</option>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => commit(sorts.filter((_, j) => j !== i))}
              aria-label={t('removeSortAria')}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        ))
      )}
    </div>
  )
}

export function SummarizeConfig({
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
  const tReports = useTranslations('reports')
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
                    {tReports(`catalog.columns.${entity.key}.${c.key}`)}
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
                    {tReports(`aggs.${fn}`)}
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
                      {tReports(`catalog.columns.${entity.key}.${c.key}`)}
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
