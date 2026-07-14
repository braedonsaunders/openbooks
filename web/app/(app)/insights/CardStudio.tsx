'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Filter, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  AGG_FUNCTIONS,
  FILTER_OPERATOR_MAP,
  getSource,
  INSIGHT_SOURCES,
  operatorsForType,
  type AggFn,
  type DateBin,
  type FilterOp,
  type InsightQuery,
  type QueryResult,
  type VizSettings,
  type VizType,
} from '@openbooks/analytics'
import { InsightResultView } from '@openbooks/analytics/viz'
import { Badge, Button, Input, Label, Select, UrlDrawer } from '@openbooks/ui'
import { VIZ_META } from './viz-meta'
import type { CardRow } from '../../api/insights/_lib'

const field = 'space-y-1.5'
const DATE_BINS: DateBin[] = ['day', 'week', 'month', 'quarter', 'year']

type MeasureState = { field: string | ''; agg: AggFn }
type DimensionState = { field: string; bin: DateBin | '' }
type FilterState = { field: string; op: FilterOp; value: string }

function toQuery(sourceKey: string, measures: MeasureState[], dimensions: DimensionState[], filters: FilterState[]): InsightQuery {
  const source = getSource(sourceKey)
  return {
    source: sourceKey,
    measures: measures.map((m) => (m.agg === 'count' ? { agg: 'count' } : { agg: m.agg, field: m.field })),
    dimensions: dimensions.map((d) => {
      const f = source?.fields.find((x) => x.key === d.field)
      return d.bin && f?.canBin ? { field: d.field, bin: d.bin } : { field: d.field }
    }),
    filters: filters
      .filter((f) => f.field && f.op)
      .map((f) => {
        const meta = FILTER_OPERATOR_MAP[f.op]
        if (!meta || meta.needsValue === 'none') return { field: f.field, op: f.op }
        if (meta.needsValue === 'list') {
          return { field: f.field, op: f.op, value: f.value.split(',').map((s) => s.trim()).filter(Boolean) }
        }
        if (meta.needsValue === 'number') return { field: f.field, op: f.op, value: Number(f.value) }
        return { field: f.field, op: f.op, value: f.value }
      }),
  }
}

export function CardStudio({
  card,
  canCreate,
  canPublish,
}: {
  card: CardRow
  canCreate: boolean
  canPublish: boolean
}) {
  const router = useRouter()
  const ro = !canCreate

  const initialQuery = (card.query ?? {}) as InsightQuery
  const [name, setName] = useState(card.name === 'Untitled card' ? '' : card.name)
  const [description, setDescription] = useState(card.description ?? '')
  const [sourceKey, setSourceKey] = useState(initialQuery.source ?? 'ledger_lines')

  const [measures, setMeasures] = useState<MeasureState[]>(
    (initialQuery.measures ?? []).map((m) => ({ field: m.field ?? '', agg: m.agg })),
  )
  const [dimensions, setDimensions] = useState<DimensionState[]>(
    (initialQuery.dimensions ?? []).map((d) => ({ field: d.field, bin: (d.bin as DateBin) ?? '' })),
  )
  const [filters, setFilters] = useState<FilterState[]>(
    (initialQuery.filters ?? []).map((f) => ({
      field: f.field,
      op: f.op,
      value: Array.isArray(f.value) ? f.value.join(', ') : f.value == null ? '' : String(f.value),
    })),
  )

  const [vizType, setVizType] = useState<VizType>(card.viz_type)
  const [vizSettings, setVizSettings] = useState<VizSettings>(card.viz_settings ?? {})
  const [status, setStatus] = useState(card.status)

  const source = getSource(sourceKey)
  const dimensionFields = useMemo(() => source?.fields.filter((f) => f.canDimension) ?? [], [source])
  const measureFields = useMemo(() => source?.fields.filter((f) => f.canMeasure) ?? [], [source])
  const allFields = source?.fields ?? []

  const query = useMemo(() => toQuery(sourceKey, measures, dimensions, filters), [sourceKey, measures, dimensions, filters])

  // -- live preview (debounced POST /api/insights/query) --------------------
  const [result, setResult] = useState<QueryResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const previewSeq = useRef(0)

  const runPreview = useCallback(async () => {
    const seq = ++previewSeq.current
    setPreviewing(true)
    setPreviewError(null)
    try {
      const res = await fetch('/api/insights/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const data = await res.json()
      if (seq !== previewSeq.current) return
      if (!res.ok) {
        setPreviewError(data.error ?? 'Query failed')
        setResult(null)
      } else {
        setResult(data as QueryResult)
      }
    } catch {
      if (seq === previewSeq.current) setPreviewError('Preview request failed')
    } finally {
      if (seq === previewSeq.current) setPreviewing(false)
    }
  }, [query])

  useEffect(() => {
    const t = setTimeout(runPreview, 350)
    return () => clearTimeout(t)
  }, [runPreview])

  // -- autosave (debounced PATCH) -------------------------------------------
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const savePayload = useMemo(
    () => ({
      name: name.trim() || 'Untitled card',
      description: description.trim() || null,
      query,
      vizType,
      vizSettings,
    }),
    [name, description, query, vizType, vizSettings],
  )
  const first = useRef(true)
  useEffect(() => {
    if (ro) return
    if (first.current) {
      first.current = false
      return
    }
    setSaveState('dirty')
    const t = setTimeout(async () => {
      setSaveState('saving')
      const res = await fetch(`/api/insights/cards/${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(savePayload),
      })
      if (res.ok) {
        setSaveState('saved')
        router.refresh()
      } else {
        setSaveState('error')
        toast.error((await res.json()).error ?? 'Autosave failed')
      }
    }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savePayload, ro])

  const [busy, setBusy] = useState(false)
  async function setPublished(next: boolean) {
    setBusy(true)
    const res = await fetch(`/api/insights/cards/${card.id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publish: next }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? 'Update failed')
    else {
      setStatus(next ? 'published' : 'draft')
      toast.success(next ? 'Card published' : 'Card returned to draft')
    }
    setBusy(false)
    router.refresh()
  }

  async function remove() {
    if (!confirm('Delete this card? It will be removed from any dashboards.')) return
    setBusy(true)
    const res = await fetch(`/api/insights/cards/${card.id}`, { method: 'DELETE' })
    if (!res.ok) {
      toast.error('Could not delete the card')
      setBusy(false)
      return
    }
    toast.success('Card deleted')
    router.push('/insights')
    router.refresh()
  }

  // When source changes, drop selections that no longer exist.
  function changeSource(next: string) {
    setSourceKey(next)
    const ns = getSource(next)
    if (!ns) return
    const keys = new Set(ns.fields.map((f) => f.key))
    setMeasures((ms) => ms.filter((m) => m.agg === 'count' || keys.has(m.field)))
    setDimensions((ds) => ds.filter((d) => keys.has(d.field)))
    setFilters((fs) => fs.filter((f) => keys.has(f.field)))
    setVizSettings({})
  }

  const nameValid = name.trim().length > 0
  const outputColumns = result?.columns ?? []
  const dimensionCols = outputColumns.filter((c) => c.role === 'dimension')
  const measureCols = outputColumns.filter((c) => c.role === 'measure')

  return (
    <UrlDrawer
      open
      closeHref="/insights"
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span>{name.trim() || 'Untitled card'}</span>
          <Badge variant={status === 'published' ? 'success' : 'outline'}>
            {status === 'published' ? 'Published' : 'Draft'}
          </Badge>
        </span>
      }
      description={canCreate ? 'Changes save automatically. Preview updates live.' : undefined}
      footer={
        <div className="flex w-full items-center gap-3">
          <span
            className={
              'text-xs ' + (saveState === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')
            }
          >
            {canCreate
              ? saveState === 'saved'
                ? 'All changes saved'
                : saveState === 'saving'
                  ? 'Saving…'
                  : saveState === 'error'
                    ? 'Save failed — fix and retry'
                    : 'Unsaved changes…'
              : null}
          </span>
          <span className="flex-1" />
          {canCreate ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={remove}>
              <Trash2 size={14} /> Delete
            </Button>
          ) : null}
          {canPublish ? (
            status === 'published' ? (
              <Button variant="outline" disabled={busy} onClick={() => setPublished(false)}>
                Unpublish
              </Button>
            ) : (
              <>
                {!nameValid ? (
                  <span className="text-xs text-slate-500 dark:text-slate-400">Name the card to publish it</span>
                ) : null}
                <Button disabled={busy || !nameValid} onClick={() => setPublished(true)}>
                  Publish
                </Button>
              </>
            )
          ) : null}
        </div>
      }
    >
      <div className="grid gap-6 p-1 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        {/* -- builder -------------------------------------------------- */}
        <div className="space-y-6">
          <section className="grid gap-4">
            <div className={field}>
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Monthly spend by department" disabled={ro} />
            </div>
            <div className={field}>
              <Label>Description</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" disabled={ro} />
            </div>
            <div className={field}>
              <Label>Source</Label>
              <Select value={sourceKey} onChange={(e) => changeSource(e.target.value)} disabled={ro}>
                {INSIGHT_SOURCES.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </Select>
              {source ? <p className="text-xs text-slate-500 dark:text-slate-400">{source.description}</p> : null}
            </div>
          </section>

          {/* -- measures ---------------------------------------------- */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Measures</h3>
              {!ro ? (
                <Button variant="outline" size="sm" onClick={() => setMeasures([...measures, { agg: 'count', field: '' }])}>
                  <Plus size={14} /> Add
                </Button>
              ) : null}
            </div>
            {measures.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">Add a measure to aggregate (or leave empty for a detail table).</p>
            ) : (
              measures.map((m, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Select
                    value={m.agg}
                    onChange={(e) => {
                      const agg = e.target.value as AggFn
                      setMeasures(measures.map((x, j) => (j === i ? { ...x, agg } : x)))
                    }}
                    disabled={ro}
                    className="w-28"
                  >
                    {AGG_FUNCTIONS.map((a) => (
                      <option key={a.key} value={a.key}>
                        {a.label}
                      </option>
                    ))}
                  </Select>
                  {m.agg !== 'count' ? (
                    <Select
                      value={m.field}
                      onChange={(e) => setMeasures(measures.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}
                      disabled={ro}
                      className="flex-1"
                    >
                      <option value="">Select field…</option>
                      {measureFields.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span className="flex-1 text-sm text-slate-500 dark:text-slate-400">of rows</span>
                  )}
                  {!ro ? (
                    <Button variant="ghost" size="sm" aria-label="Remove measure" onClick={() => setMeasures(measures.filter((_, j) => j !== i))}>
                      <Trash2 size={14} />
                    </Button>
                  ) : null}
                </div>
              ))
            )}
          </section>

          {/* -- dimensions -------------------------------------------- */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Group by</h3>
              {!ro ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDimensions([...dimensions, { field: dimensionFields[0]?.key ?? '', bin: '' }])}
                >
                  <Plus size={14} /> Add
                </Button>
              ) : null}
            </div>
            {dimensions.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">Group rows by a dimension to summarize them.</p>
            ) : (
              dimensions.map((d, i) => {
                const f = source?.fields.find((x) => x.key === d.field)
                return (
                  <div key={i} className="flex items-center gap-2">
                    <Select
                      value={d.field}
                      onChange={(e) => setDimensions(dimensions.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}
                      disabled={ro}
                      className="flex-1"
                    >
                      {dimensionFields.map((ff) => (
                        <option key={ff.key} value={ff.key}>
                          {ff.label}
                        </option>
                      ))}
                    </Select>
                    {f?.canBin ? (
                      <Select
                        value={d.bin}
                        onChange={(e) => setDimensions(dimensions.map((x, j) => (j === i ? { ...x, bin: e.target.value as DateBin | '' } : x)))}
                        disabled={ro}
                        className="w-28"
                      >
                        <option value="">Exact</option>
                        {DATE_BINS.map((b) => (
                          <option key={b} value={b}>
                            by {b}
                          </option>
                        ))}
                      </Select>
                    ) : null}
                    {!ro ? (
                      <Button variant="ghost" size="sm" aria-label="Remove dimension" onClick={() => setDimensions(dimensions.filter((_, j) => j !== i))}>
                        <Trash2 size={14} />
                      </Button>
                    ) : null}
                  </div>
                )
              })
            )}
          </section>

          {/* -- filters ------------------------------------------------ */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <Filter size={14} /> Filters
              </h3>
              {!ro ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setFilters([...filters, { field: allFields[0]?.key ?? '', op: 'eq', value: '' }])}
                >
                  <Plus size={14} /> Add
                </Button>
              ) : null}
            </div>
            {filters.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">No filters — the card covers all rows.</p>
            ) : (
              filters.map((flt, i) => {
                const f = allFields.find((x) => x.key === flt.field)
                const ops = f ? operatorsForType(f.semanticType) : []
                const meta = FILTER_OPERATOR_MAP[flt.op]
                const needsValue = meta && meta.needsValue !== 'none'
                return (
                  <div key={i} className="space-y-1.5 rounded-lg border border-slate-200 p-2 dark:border-slate-800">
                    <div className="flex items-center gap-2">
                      <Select
                        value={flt.field}
                        onChange={(e) => {
                          const nf = allFields.find((x) => x.key === e.target.value)
                          const validOps = nf ? operatorsForType(nf.semanticType) : []
                          const op = validOps.some((o) => o.key === flt.op) ? flt.op : (validOps[0]?.key ?? 'eq')
                          setFilters(filters.map((x, j) => (j === i ? { ...x, field: e.target.value, op } : x)))
                        }}
                        disabled={ro}
                        className="flex-1"
                      >
                        {allFields.map((ff) => (
                          <option key={ff.key} value={ff.key}>
                            {ff.label}
                          </option>
                        ))}
                      </Select>
                      {!ro ? (
                        <Button variant="ghost" size="sm" aria-label="Remove filter" onClick={() => setFilters(filters.filter((_, j) => j !== i))}>
                          <Trash2 size={14} />
                        </Button>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={flt.op}
                        onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, op: e.target.value as FilterOp } : x)))}
                        disabled={ro}
                        className="flex-1"
                      >
                        {ops.map((o) => (
                          <option key={o.key} value={o.key}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                      {needsValue ? (
                        <Input
                          value={flt.value}
                          onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                          placeholder={
                            meta?.needsValue === 'list'
                              ? 'a, b, c'
                              : meta?.needsValue === 'number'
                                ? '30'
                                : f?.semanticType === 'date'
                                  ? 'YYYY-MM-DD'
                                  : 'Value'
                          }
                          disabled={ro}
                          className="flex-1"
                        />
                      ) : null}
                    </div>
                  </div>
                )
              })
            )}
          </section>
        </div>

        {/* -- preview + viz settings --------------------------------- */}
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {VIZ_META.map((v) => (
              <button
                key={v.value}
                type="button"
                disabled={ro}
                onClick={() => setVizType(v.value)}
                className={
                  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm transition-colors disabled:opacity-60 ' +
                  (vizType === v.value
                    ? 'border-teal-600 bg-teal-50 text-teal-700 dark:border-teal-400 dark:bg-teal-950/40 dark:text-teal-300'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-900')
                }
              >
                <v.Icon size={15} /> {v.label}
              </button>
            ))}
          </div>

          {vizType !== 'table' ? (
            <VizSettingsEditor
              vizType={vizType}
              settings={vizSettings}
              onChange={setVizSettings}
              dimensionCols={dimensionCols}
              measureCols={measureCols}
              disabled={ro}
            />
          ) : null}

          <div className="min-h-[22rem] rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
            {previewError ? (
              <div className="flex h-full min-h-[20rem] items-center justify-center px-4 text-center text-sm text-red-600 dark:text-red-400">
                {previewError}
              </div>
            ) : !result ? (
              <div className="flex h-full min-h-[20rem] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
                {previewing ? 'Running preview…' : 'Build a query to preview.'}
              </div>
            ) : (
              <div className="h-[20rem]">
                <InsightResultView result={result} vizType={vizType} settings={vizSettings} />
              </div>
            )}
          </div>
          {result ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {result.rowCount.toLocaleString()} row{result.rowCount === 1 ? '' : 's'}
              {result.truncated ? ' (capped at 10,000)' : ''} · {result.durationMs} ms
            </p>
          ) : null}
        </div>
      </div>
    </UrlDrawer>
  )
}

function VizSettingsEditor({
  vizType,
  settings,
  onChange,
  dimensionCols,
  measureCols,
  disabled,
}: {
  vizType: VizType
  settings: VizSettings
  onChange: (s: VizSettings) => void
  dimensionCols: { key: string; label: string }[]
  measureCols: { key: string; label: string }[]
  disabled: boolean
}) {
  const set = (patch: Partial<VizSettings>) => onChange({ ...settings, ...patch })
  const toggle = (
    label: string,
    key: keyof VizSettings,
  ) => (
    <label className="flex items-center gap-1.5 text-sm">
      <input
        type="checkbox"
        checked={settings[key] === true}
        onChange={(e) => set({ [key]: e.target.checked } as Partial<VizSettings>)}
        disabled={disabled}
        className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
      />
      {label}
    </label>
  )

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className={field + ' min-w-[9rem]'}>
        <Label>Category</Label>
        <Select value={settings.categoryField ?? ''} onChange={(e) => set({ categoryField: e.target.value || undefined })} disabled={disabled}>
          <option value="">Auto</option>
          {dimensionCols.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>
      <div className={field + ' min-w-[9rem]'}>
        <Label>Value</Label>
        <Select
          value={settings.valueFields?.[0] ?? ''}
          onChange={(e) => set({ valueFields: e.target.value ? [e.target.value] : undefined })}
          disabled={disabled}
        >
          <option value="">All measures</option>
          {measureCols.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-3 pb-2">
        {(vizType === 'bar' || vizType === 'area') && toggle('Stacked', 'stacked')}
        {vizType === 'bar' && toggle('Horizontal', 'horizontal')}
        {(vizType === 'line' || vizType === 'area') && toggle('Smooth', 'smooth')}
        {toggle('Values', 'showValues')}
        {toggle('Hide legend', 'hideLegend')}
      </div>
    </div>
  )
}
