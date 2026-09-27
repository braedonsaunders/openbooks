'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Search, Trash2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, SearchSelect, Select } from '@openbooks/ui'
import {
  defaultColumnsFor,
  REPORT_AGG_FNS,
  REPORT_TEMPORAL_BINS,
  canAddAggregateMeasure,
  canAddFormulaMeasure,
  type ReportAggFn,
  type ReportBreakout,
  type ReportCustomQuery,
  type ReportEntity,
  type ReportEntityColumn,
  type ReportFormulaExpr,
  type ReportFormulaFormat,
  type ReportFormulaGuard,
  type ReportMeasure,
  type ReportRuleGroup,
  type ReportTemporalBin,
} from '@openbooks/reports'
import { reportColumnGroup } from '../../../lib/report-builder-catalog'
import { FilterTree } from './custom/FilterTree'

const BUILDER_AGG_FNS = REPORT_AGG_FNS.filter((fn) => fn !== 'formula')

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

/** Columns valid as an aggregate target for a given fn (numbers and money
 * for sum/avg — the engine aggregates money measures with its blending
 * disclosure; the builder offered only numbers). */
export function measureColumns(entity: ReportEntity, fn: ReportAggFn) {
  if (fn === 'sum' || fn === 'avg' || fn === 'opening' || fn === 'closing') {
    return entity.columns.filter((c) => c.kind === 'number' || c.kind === 'money')
  }
  return entity.columns.filter((c) => c.kind !== 'uuid')
}

function nextMeasureKey(measures: readonly ReportMeasure[]): string {
  const used = new Set(measures.flatMap((measure) => measure.key ? [measure.key] : []))
  let candidate = 1
  while (used.has(`m${candidate}`)) candidate += 1
  return `m${candidate}`
}

function ensureMeasureKeys(measures: readonly ReportMeasure[]): ReportMeasure[] {
  const keyed = [...measures]
  for (let index = 0; index < keyed.length; index += 1) {
    if (!keyed[index]!.key) {
      keyed[index] = { ...keyed[index]!, key: nextMeasureKey(keyed) }
    }
  }
  return keyed
}

function measureLabel(measure: ReportMeasure, entity: ReportEntity, tReports: ReturnType<typeof useTranslations>): string {
  if (measure.label?.trim()) return measure.label
  if (measure.column) {
    const column = entity.columns.find((candidate) => candidate.key === measure.column)
    if (entity.key.startsWith('custom:')) return column?.label ?? measure.column
    const key = `catalog.columns.${entity.key}.${measure.column}`
    return tReports.has(key) ? tReports(key) : column?.label ?? measure.column
  }
  return tReports(`aggs.${measure.fn}`)
}

function FormulaExpressionEditor({
  expression,
  measures,
  entity,
  ownerKey,
  inventoryEnabled,
  disabled,
  onChange,
}: {
  expression: ReportFormulaExpr
  measures: readonly ReportMeasure[]
  entity: ReportEntity
  ownerKey: string
  inventoryEnabled: boolean
  disabled: boolean
  onChange: (expression: ReportFormulaExpr) => void
}) {
  const t = useTranslations('reports.custom.builder')
  const tReports = useTranslations('reports')
  const kind = 'ref' in expression ? 'measure' : 'const' in expression ? 'constant' : 'operation'
  const options = measures
    .filter((measure) => measure.key && measure.key !== ownerKey)
    .map((measure) => ({ value: measure.key!, label: measureLabel(measure, entity, tReports) }))

  const changeKind = (next: string) => {
    if (next === 'measure') onChange({ ref: options[0]?.value ?? '' })
    else if (next === 'constant') onChange({ const: '0' })
    else onChange({ op: '/', left: { const: '0' }, right: { const: '1' } })
  }

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex items-center gap-2">
        <Select
          className="h-8 w-36"
          aria-label={t('formulaOperandKind')}
          value={kind}
          onChange={(event) => changeKind(event.target.value)}
          disabled={disabled}
        >
          <option value="measure" disabled={options.length === 0}>{t('formulaOperandMeasure')}</option>
          <option value="constant">{t('formulaOperandConstant')}</option>
          <option value="operation">{t('formulaOperandOperation')}</option>
        </Select>
        {kind === 'measure' ? (
          <SearchSelect
            className="min-w-0 flex-1"
            triggerClassName="h-8"
            value={'ref' in expression ? expression.ref : ''}
            onChange={(ref) => onChange({ ref })}
            options={options}
            searchable
            disabled={disabled}
            sheetTitle={t('formulaOperandMeasure')}
            ariaLabel={t('formulaOperandMeasure')}
          />
        ) : null}
        {kind === 'constant' ? (
          <Input
            className="h-8 min-w-0 flex-1"
            type="text"
            inputMode="decimal"
            aria-label={t('formulaOperandConstant')}
            value={'const' in expression ? expression.const : ''}
            onChange={(event) => onChange({ const: event.target.value })}
            disabled={disabled}
          />
        ) : null}
        {kind === 'operation' && 'op' in expression ? (
          <Select
            className="h-8 w-24"
            aria-label={t('formulaOperator')}
            value={expression.op}
            onChange={(event) => onChange({ ...expression, op: event.target.value as '+' | '-' | '*' | '/' })}
            disabled={disabled}
          >
            <option value="+">{t('formulaAdd')}</option>
            <option value="-">{t('formulaSubtract')}</option>
            <option value="*">{t('formulaMultiply')}</option>
            <option value="/">{t('formulaDivide')}</option>
          </Select>
        ) : null}
      </div>
      {kind === 'operation' && 'op' in expression ? (
        <div className="grid gap-2 pl-3 sm:grid-cols-2">
          <FormulaExpressionEditor
            expression={expression.left}
            measures={measures}
            entity={entity}
            ownerKey={ownerKey}
            inventoryEnabled={inventoryEnabled}
            disabled={disabled}
            onChange={(left) => onChange({ ...expression, left })}
          />
          <FormulaExpressionEditor
            expression={expression.right}
            measures={measures}
            entity={entity}
            ownerKey={ownerKey}
            inventoryEnabled={inventoryEnabled}
            disabled={disabled}
            onChange={(right) => onChange({ ...expression, right })}
          />
        </div>
      ) : null}
    </div>
  )
}

export function MeasureEditor({
  entity,
  measures,
  onChange,
  inventoryEnabled,
  disabled = false,
  error,
}: {
  entity: ReportEntity
  measures: ReportMeasure[]
  onChange: (measures: ReportMeasure[]) => void
  inventoryEnabled: boolean
  disabled?: boolean
  error?: string | null
}) {
  const t = useTranslations('reports.custom.builder')
  const tReports = useTranslations('reports')
  const optionsFor = (columns: ReportEntityColumn[]) => columns.map((column) => ({
    value: column.key,
    label: entity.key.startsWith('custom:') ? column.label : tReports(`catalog.columns.${entity.key}.${column.key}`),
    group: t(`fieldGroups.${reportColumnGroup(entity, column)}`),
  }))
  const updateMeasure = (index: number, measure: ReportMeasure) => {
    const next = [...measures]
    next[index] = measure
    onChange(next)
  }
  const addAggregate = () => {
    const keyed = ensureMeasureKeys(measures)
    onChange([...keyed, { fn: 'count', key: nextMeasureKey(keyed) }])
  }
  const addFormula = () => {
    const keyed = ensureMeasureKeys(measures)
    const first = keyed.find((measure) => measure.key)
    const secondCandidate = keyed.find((measure) => measure.key && measure.key !== first?.key)
    const unitOf = (measure: ReportMeasure | undefined): 'money' | 'ratio' | 'number' => {
      if (!measure) return 'number'
      if (measure.fn === 'formula') return measure.format === 'money' ? 'money' : measure.format === 'number' ? 'number' : 'ratio'
      return measure.fn !== 'count' && measure.fn !== 'count_distinct'
        && entity.columns.find((column) => column.key === measure.column)?.kind === 'money'
        ? 'money'
        : 'number'
    }
    const firstUnit = unitOf(first)
    const secondCandidateUnit = unitOf(secondCandidate)
    const second = first && firstUnit !== 'money' && secondCandidateUnit === 'money' ? first : secondCandidate
    const secondUnit = unitOf(second)
    const references = first && second ? [first, second] : []
    const expression: ReportFormulaExpr = references.length === 2
      ? { op: '/', left: { ref: references[0]!.key! }, right: { ref: references[1]!.key! } }
      : { const: '0' }
    const format = references.length !== 2 ? 'number' : firstUnit === 'money' && secondUnit !== 'money' ? 'money' : 'ratio'
    onChange([
      ...keyed,
      { fn: 'formula', key: nextMeasureKey(keyed), label: '', expr: expression, format },
    ])
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>{t('measures')}</Label>
        <div className="flex gap-1">
          {canAddAggregateMeasure(measures) ? (
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={addAggregate}>
              {t('addMeasure')}
            </Button>
          ) : null}
          {canAddFormulaMeasure(measures) ? (
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={addFormula}>
              {t('addFormula')}
            </Button>
          ) : null}
        </div>
      </div>
      {error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      ) : null}
      {measures.map((measure, index) => {
        const columns = measureColumns(entity, measure.fn)
        const supportedFunctions = [
          ...BUILDER_AGG_FNS.filter((fn) => fn !== 'opening' && fn !== 'closing' || Boolean(entity.timeKey)),
          'formula' as const,
        ]
        const functionOptions = supportedFunctions.includes(measure.fn)
          ? supportedFunctions
          : [...supportedFunctions, measure.fn]
        const setLabel = (label: string) => updateMeasure(index, { ...measure, label })
        const changeFunction = (fn: ReportAggFn) => {
          if (fn === measure.fn) return
          if (fn === 'formula') {
            const next = { ...measure, fn, expr: { const: '0' }, format: 'number' as const }
            delete next.column
            delete next.filter
            delete next.scale
            delete next.undefinedLabel
            delete next.guards
            updateMeasure(index, next)
            return
          }
          const next = { ...measure, fn }
          delete next.expr
          delete next.format
          delete next.scale
          delete next.undefinedLabel
          delete next.guards
          const validColumns = measureColumns(entity, fn)
          const column = fn === 'count' ? undefined
            : measure.column && validColumns.some((candidate) => candidate.key === measure.column)
              ? measure.column
              : validColumns[0]?.key
          if (column) next.column = column
          else delete next.column
          updateMeasure(index, next)
        }
        const formula = measure.fn === 'formula'
        const filterOn = Boolean(measure.filter)

        return (
          <div key={measure.key ?? index} className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <Select
                className="h-8 w-36"
                aria-label={tReports(`aggs.${measure.fn}`)}
                value={measure.fn}
                disabled={disabled}
                onChange={(event) => changeFunction(event.target.value as ReportAggFn)}
              >
                {functionOptions.map((fn) => (
                  <option key={fn} value={fn}>{tReports(`aggs.${fn}`)}</option>
                ))}
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange(measures.length > 1 ? measures.filter((_, j) => j !== index) : measures)}
                aria-label={t('removeMeasureAria')}
                disabled={disabled || measures.length <= 1}
              >
                <Trash2 size={14} />
              </Button>
            </div>
            <div className="space-y-1">
              <Label>{t('measureLabel')}</Label>
              <Input aria-label={t('measureLabel')} value={measure.label ?? ''} onChange={(event) => setLabel(event.target.value)} disabled={disabled} />
            </div>
            {!formula ? (
              <>
                {measure.fn !== 'count' ? (
                  <SearchSelect
                    className="min-w-0"
                    triggerClassName="h-8"
                    value={measure.column ?? ''}
                    onChange={(column) => updateMeasure(index, { ...measure, column })}
                    options={optionsFor(columns)}
                    searchable
                    disabled={disabled}
                    sheetTitle={t('measures')}
                    ariaLabel={t('measures')}
                  />
                ) : null}
                <Button
                  type="button"
                  variant={filterOn ? 'outline' : 'ghost'}
                  size="sm"
                  aria-pressed={filterOn}
                  disabled={disabled}
                  onClick={() => {
                    if (measure.filter) {
                      const { filter: _filter, ...withoutFilter } = measure
                      updateMeasure(index, withoutFilter)
                    } else {
                      updateMeasure(index, { ...measure, filter: { combinator: 'and', rules: [] } })
                    }
                  }}
                >
                  {t('filterThisMeasure')}
                </Button>
                {measure.filter ? (
                  <fieldset disabled={disabled} className="min-w-0">
                  <FilterTree
                    entity={entity}
                    group={measure.filter}
                    inventoryEnabled={inventoryEnabled}
                    onChange={(filter: ReportRuleGroup) => {
                      if (filter.rules.length === 0) {
                        const { filter: _filter, ...withoutFilter } = measure
                        updateMeasure(index, withoutFilter)
                      } else updateMeasure(index, { ...measure, filter })
                    }}
                  />
                  </fieldset>
                ) : null}
              </>
            ) : (
              <>
                <div className="space-y-1">
                  <Label>{t('formulaExpression')}</Label>
                  <FormulaExpressionEditor
                    expression={measure.expr ?? { const: '0' }}
                    measures={measures}
                    entity={entity}
                    ownerKey={measure.key ?? ''}
                    inventoryEnabled={inventoryEnabled}
                    disabled={disabled}
                    onChange={(expr) => updateMeasure(index, { ...measure, expr })}
                  />
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label>{t('formulaFormat')}</Label>
                    <Select
                      className="h-8 w-full"
                      aria-label={t('formulaFormat')}
                      value={measure.format ?? 'ratio'}
                      onChange={(event) => updateMeasure(index, { ...measure, format: event.target.value as ReportFormulaFormat })}
                      disabled={disabled}
                    >
                      {(['ratio', 'percent', 'money', 'number'] as const).map((format) => (
                        <option key={format} value={format}>{tReports(`formats.${format}`)}</option>
                      ))}
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>{t('formulaUndefinedLabel')}</Label>
                    <Input
                      aria-label={t('formulaUndefinedLabel')}
                      value={measure.undefinedLabel ?? ''}
                      placeholder={tReports('run.undefinedFormula')}
                      onChange={(event) => updateMeasure(index, { ...measure, undefinedLabel: event.target.value || undefined })}
                      disabled={disabled}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>{t('formulaGuards')}</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled || !measures.some((candidate) => candidate.key && candidate.key !== measure.key)}
                      onClick={() => updateMeasure(index, {
                        ...measure,
                        guards: [...(measure.guards ?? []), { measure: measures.find((candidate) => candidate.key && candidate.key !== measure.key)?.key ?? '', when: 'zero', label: '' }],
                      })}
                    >
                      {t('addFormulaGuard')}
                    </Button>
                  </div>
                  {(measure.guards ?? []).map((guard, guardIndex) => (
                    <FormulaGuardEditor
                      key={`${measure.key ?? index}-${guardIndex}`}
                      guard={guard}
                      measures={measures}
                      entity={entity}
                      ownerKey={measure.key ?? ''}
                      disabled={disabled}
                      onChange={(nextGuard) => updateMeasure(index, {
                        ...measure,
                        guards: (measure.guards ?? []).map((existing, j) => j === guardIndex ? nextGuard : existing),
                      })}
                      onRemove={() => updateMeasure(index, {
                        ...measure,
                        guards: (measure.guards ?? []).filter((_, j) => j !== guardIndex),
                      })}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

function FormulaGuardEditor({
  guard,
  measures,
  entity,
  ownerKey,
  disabled,
  onChange,
  onRemove,
}: {
  guard: ReportFormulaGuard
  measures: readonly ReportMeasure[]
  entity: ReportEntity
  ownerKey: string
  disabled: boolean
  onChange: (guard: ReportFormulaGuard) => void
  onRemove: () => void
}) {
  const t = useTranslations('reports.custom.builder')
  const tReports = useTranslations('reports')
  const options = measures
    .filter((measure) => measure.key && measure.key !== ownerKey)
    .map((measure) => ({ value: measure.key!, label: measureLabel(measure, entity, tReports) }))

  return (
    <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)_auto]">
      <SearchSelect
        value={guard.measure}
        onChange={(measure) => onChange({ ...guard, measure })}
        options={options}
        searchable
        disabled={disabled}
        sheetTitle={t('formulaGuardMeasure')}
        ariaLabel={t('formulaGuardMeasure')}
      />
      <Select
        className="h-8"
        value={guard.when}
        onChange={(event) => onChange({ ...guard, when: event.target.value as 'zero' | 'null' })}
        disabled={disabled}
        aria-label={t('formulaGuardWhen')}
      >
        <option value="zero">{t('formulaGuardZero')}</option>
        <option value="null">{t('formulaGuardNull')}</option>
      </Select>
      <Input
        aria-label={t('formulaGuardLabel')}
        value={guard.label}
        onChange={(event) => onChange({ ...guard, label: event.target.value })}
        placeholder={t('formulaGuardLabel')}
        disabled={disabled}
      />
      <Button type="button" variant="ghost" size="sm" aria-label={t('removeFormulaGuardAria')} onClick={onRemove} disabled={disabled}>
        <Trash2 size={14} />
      </Button>
    </div>
  )
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
  inventoryEnabled,
  error,
}: {
  entity: ReportEntity
  query: ReportCustomQuery
  patch: (n: Partial<ReportCustomQuery>) => void
  section?: 'all' | 'grouping' | 'measures'
  disabled?: boolean
  inventoryEnabled: boolean
  error?: string | null
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

      {section !== 'grouping' ? (
        <MeasureEditor
          entity={entity}
          measures={measures}
          onChange={(next) => patch({ measures: next })}
          inventoryEnabled={inventoryEnabled}
          disabled={disabled}
          error={error}
        />
      ) : null}
    </>
  )
}
