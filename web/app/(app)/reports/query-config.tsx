'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Search, Trash2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, SearchSelect, Select } from '@openbooks/ui'
import {
  defaultColumnsFor,
  REPORT_AGG_FNS,
  REPORT_TEMPORAL_BINS,
  type ReportAggFn,
  type ReportBreakout,
  type ReportCustomQuery,
  type ReportEntity,
  type ReportEntityColumn,
  type ReportMeasure,
  type ReportTemporalBin,
} from '@openbooks/reports'
import { reportColumnGroup } from '../../../lib/report-builder-catalog'

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
  section = 'all',
}: {
  entity: ReportEntity
  query: ReportCustomQuery
  patch: (n: Partial<ReportCustomQuery>) => void
  columns: ReportEntity['columns']
  disabled?: boolean
  section?: 'all' | 'columns' | 'grouping'
}) {
  const t = useTranslations('reports.custom.builder')
  const tReports = useTranslations('reports')
  const [columnSearch, setColumnSearch] = useState('')
  const selected = query.columns ?? []
  const labels = query.columnLabels ?? {}
  const defaultLabel = (key: string) => (entity.key.startsWith('custom:') ? entity.columns.find(c => c.key === key)?.label ?? key : tReports(`catalog.columns.${entity.key}.${key}`))

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
  const search = columnSearch.trim().toLocaleLowerCase()
  const available = columns.filter((column) => {
    if (selected.includes(column.key)) return false
    if (!search) return true
    const group = reportColumnGroup(entity, column)
    return `${defaultLabel(column.key)} ${column.key} ${column.kind} ${t(`fieldGroups.${group}`)}`
      .toLocaleLowerCase()
      .includes(search)
  })
  const availableGroups = (['record', 'related', 'identifiers'] as const)
    .map((group) => ({ group, columns: available.filter((column) => reportColumnGroup(entity, column) === group) }))
    .filter((entry) => entry.columns.length > 0)
  const columnOptions = columns.map((column) => ({
    value: column.key,
    label: defaultLabel(column.key),
    group: t(`fieldGroups.${reportColumnGroup(entity, column)}`),
  }))

  return (
    <>
      {section !== 'grouping' ? <div className="space-y-3">
        <Label>{t('selectedColumns')}</Label>
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('columnPickerHint')}</p>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
          <Input
            className="h-9 pl-8 text-sm"
            value={columnSearch}
            onChange={(event) => setColumnSearch(event.target.value)}
            placeholder={t('columnSearchPlaceholder')}
            disabled={disabled}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setColumns(defaultColumnsFor(entity))}>
            {t('useDefaults')}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setColumns(columns.map((column) => column.key))}>
            {t('selectAll')}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setColumns([])}>
            {t('clearAll')}
          </Button>
        </div>
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
        {availableGroups.map(({ group, columns: groupedColumns }) => (
          <div key={group} className="space-y-1.5 rounded-lg border border-slate-200 p-2.5 dark:border-slate-800">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{t(`fieldGroups.${group}`)}</p>
              <span className="text-[11px] tabular-nums text-slate-400 dark:text-slate-500">{groupedColumns.length}</span>
            </div>
            <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
              {groupedColumns.map((column) => (
                <button
                  key={column.key}
                  type="button"
                  disabled={disabled}
                  onClick={() => setColumns([...selected, column.key])}
                  className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition-colors hover:border-teal-400 hover:text-teal-700 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:border-teal-500 dark:hover:text-teal-300"
                >
                  <span className="inline-flex items-center gap-1"><Plus size={11} /> {defaultLabel(column.key)}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        {available.length === 0 && search ? <p className="text-xs text-slate-400 dark:text-slate-500">{t('noColumnsMatch')}</p> : null}
      </div> : null}
      {section !== 'columns' ? <div className="space-y-1.5">
        <Label>{t('sectionBy')}</Label>
        <SearchSelect
          value={query.groupBy ?? ''}
          onChange={(value) => patch({ groupBy: value || null })}
          options={[{ value: '', label: t('noSections') }, ...columnOptions]}
          searchable
          disabled={disabled}
          sheetTitle={t('sectionBy')}
          ariaLabel={t('sectionBy')}
        />
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t('sectionByHint')}
        </p>
      </div> : null}
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
  const columnOptions = entity.columns.map((column) => ({
    value: column.key,
    label: entity.key.startsWith('custom:') ? column.label : tReports(`catalog.columns.${entity.key}.${column.key}`),
    group: t(`fieldGroups.${reportColumnGroup(entity, column)}`),
  }))

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
        <SearchSelect
          value=""
          disabled={disabled}
          onChange={(column) => column && commit([{ column, direction: 'desc' }])}
          options={[{ value: '', label: t('sortDefault') }, ...columnOptions]}
          searchable
          sheetTitle={t('sortBy')}
          ariaLabel={t('sortBy')}
        />
      ) : (
        sorts.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            {i > 0 ? (
              <span className="w-14 shrink-0 text-right text-[11px] text-slate-400 dark:text-slate-500">{t('thenBy')}</span>
            ) : null}
            <SearchSelect
              className="min-w-0 flex-1"
              triggerClassName="h-8"
              value={s.column}
              disabled={disabled}
              onChange={(column) => setLevel(i, { column, direction: s.direction })}
              options={columnOptions.map((option) => ({
                ...option,
                disabled: usedColumns.has(option.value) && option.value !== s.column,
              }))}
              searchable
              sheetTitle={t('sortBy')}
              ariaLabel={t('sortBy')}
            />
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
  section = 'all',
  disabled = false,
}: {
  entity: ReportEntity
  query: ReportCustomQuery
  patch: (n: Partial<ReportCustomQuery>) => void
  section?: 'all' | 'grouping' | 'measures'
  disabled?: boolean
}) {
  const t = useTranslations('reports.custom.builder')
  const tc = useTranslations('common')
  const tReports = useTranslations('reports')
  const breakouts = query.breakouts ?? []
  const measures = query.measures ?? []
  const labelFor = (column: ReportEntityColumn) => (
    entity.key.startsWith('custom:') ? column.label : tReports(`catalog.columns.${entity.key}.${column.key}`)
  )
  const optionsFor = (columns: ReportEntityColumn[]) => columns.map((column) => ({
    value: column.key,
    label: labelFor(column),
    group: t(`fieldGroups.${reportColumnGroup(entity, column)}`),
  }))

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
      {section !== 'measures' ? <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>{t('groupBy')}</Label>
          {breakouts.length < 6 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
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
              <SearchSelect
                className="min-w-0 flex-1"
                triggerClassName="h-8"
                value={b.column}
                onChange={(col) => {
                  setBreakout(i, { column: col, ...(isTemporal(entity, col) && b.bin ? { bin: b.bin } : {}) })
                }}
                options={optionsFor(entity.columns)}
                searchable
                disabled={disabled}
                sheetTitle={t('groupBy')}
                ariaLabel={t('groupBy')}
              />
              {temporal ? (
                <Select
                  className="h-8 w-28"
                  value={b.bin ?? ''}
                  disabled={disabled}
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
                disabled={disabled}
                onClick={() => patch({ breakouts: breakouts.filter((_, j) => j !== i) })}
                aria-label={t('removeGroupAria')}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          )
        })}
      </div> : null}

      {section !== 'grouping' ? <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>{t('measures')}</Label>
          {measures.length < 8 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
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
                disabled={disabled}
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
                <SearchSelect
                  className="min-w-0 flex-1"
                  triggerClassName="h-8"
                  value={m.column ?? ''}
                  onChange={(column) => setMeasure(i, { ...m, column })}
                  options={optionsFor(cols)}
                  searchable
                  disabled={disabled}
                  sheetTitle={t('measures')}
                  ariaLabel={t('measures')}
                />
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  patch({ measures: measures.length > 1 ? measures.filter((_, j) => j !== i) : measures })
                }
                aria-label={t('removeMeasureAria')}
                disabled={disabled || measures.length <= 1}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          )
        })}
      </div> : null}
    </>
  )
}
