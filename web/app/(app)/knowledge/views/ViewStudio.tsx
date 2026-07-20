'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Download, ExternalLink, FileText, Play, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Label, Select, UrlDrawer } from '@openbooks/ui'
import {
  REPORT_ENTITIES,
  REPORT_ENTITY_MAP,
  defaultColumnsFor,
  isOperationalColumn,
  type ReportCustomQuery,
  type ReportRunResult,
} from '@openbooks/reports'
import { confirmDialog } from '../../../../lib/confirm'
import { RowsConfig, SortConfig, SummarizeConfig } from '../../reports/query-config'
import { FilterTree } from '../../reports/custom/FilterTree'
import { ResultView } from '../../reports/custom/ResultView'
import type { ViewRow, ViewScope } from '../../../../lib/views'
import { ReportPaper } from '../../reports/ReportPaper'

const field = 'space-y-1.5'

/**
 * The view builder flyout. Builds the SAME ReportCustomQuery plan as the report
 * studio (shared RowsConfig/SummarizeConfig/FilterTree/ResultView), adds view
 * metadata (name, scope), autosaves, runs a live preview via the shared report
 * run route, and exports to PDF/Excel/CSV.
 */
export function ViewStudio({
  view,
  canCreate,
  canAdmin,
  company,
}: {
  view: ViewRow
  canCreate: boolean
  canAdmin: boolean
  company: string
}) {
  const t = useTranslations('knowledge.views.studio')
  const tb = useTranslations('reports.custom.builder')
  const tc = useTranslations('common')
  const tReports = useTranslations('reports')
  const router = useRouter()

  const [name, setName] = useState(view.name)
  const [description, setDescription] = useState(view.description ?? '')
  const [query, setQuery] = useState<ReportCustomQuery>(view.query)
  const [scope, setScope] = useState<ViewScope>(view.scope)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [preview, setPreview] = useState<ReportRunResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)

  const entity = REPORT_ENTITY_MAP[query.entity] ?? REPORT_ENTITY_MAP.ledger_lines!
  const mode = query.mode ?? 'rows'
  const patch = useCallback((next: Partial<ReportCustomQuery>) => setQuery((q) => ({ ...q, ...next })), [])

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

  // --- live preview (debounced) via the shared report run route (ad-hoc) ---
  const runPreview = useCallback(async (plan: ReportCustomQuery) => {
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
      setPreviewError(data.error ?? tb('previewFailed'))
    }
    setPreviewing(false)
  }, [tb])

  const firstPreview = useRef(true)
  useEffect(() => {
    const timer = setTimeout(() => runPreview(query), firstPreview.current ? 0 : 500)
    firstPreview.current = false
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  // --- autosave (debounced PATCH) ---
  const firstSave = useRef(true)
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false
      return
    }
    setSaveState('dirty')
    const timer = setTimeout(async () => {
      setSaveState('saving')
      const res = await fetch(`/api/views/${view.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, query, scope }),
      })
      if (res.ok) {
        setSaveState('saved')
      } else {
        setSaveState('error')
        toast.error((await res.json()).error ?? tc('feedback.saveFailed'))
      }
    }, 700)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, description, query, scope])

  const selectableColumns = useMemo(() => entity.columns.filter(isOperationalColumn), [entity])

  async function remove() {
    if (
      !(await confirmDialog({
        title: t('deleteConfirm'),
        message: name.trim() || t('untitled'),
        confirmLabel: tc('actions.delete'),
        tone: 'danger',
      }))
    )
      return
    const res = await fetch(`/api/views/${view.id}`, { method: 'DELETE' })
    if (res.ok) {
      router.push('/knowledge/views')
      router.refresh()
    } else {
      toast.error((await res.json()).error ?? tc('feedback.deleteFailed'))
    }
  }

  return (
    <UrlDrawer
      open
      closeHref="/knowledge/views"
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="truncate">{name.trim() || t('untitled')}</span>
          <Badge variant={scope === 'shared' ? 'secondary' : 'outline'}>{t(`scope.${scope}` as never)}</Badge>
        </span>
      }
      description={canCreate ? t('autosaveHint') : undefined}
      headerActions={
        <>
          <Button variant="outline" asChild>
            <Link href={`/knowledge/views/${view.id}`}><ExternalLink size={15} /> {t('viewResults')}</Link>
          </Button>
          <Button variant="outline" asChild>
            <a href={`/api/views/${view.id}/export?format=pdf`}><FileText size={15} /> {t('exportPdf')}</a>
          </Button>
          <Button variant="outline" asChild>
            <a href={`/api/views/${view.id}/export?format=xlsx`}><Download size={15} /> {t('exportXlsx')}</a>
          </Button>
          <Button variant="outline" asChild>
            <a href={`/api/views/${view.id}/export?format=csv`}><Download size={15} /> {t('exportCsv')}</a>
          </Button>
          {canAdmin ? (
            <Button variant="ghost" size="sm" onClick={remove}>
              <Trash2 size={14} /> {tc('actions.delete')}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-5">
        <div className={field}>
          <Label>{tb('namePlaceholder')}</Label>
          <Input className="h-9" value={name} onChange={(e) => setName(e.target.value)} placeholder={tb('namePlaceholder')} disabled={!canCreate} />
          <Input
            className="h-8 text-sm"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={tb('descriptionPlaceholder')}
            disabled={!canCreate}
          />
          {canCreate ? (
            <div className="flex items-center gap-3">
              <Label className="mb-0">{t('scopeLabel')}</Label>
              <Select className="h-8 w-40" value={scope} onChange={(e) => setScope(e.target.value as ViewScope)} disabled={!canCreate}>
                <option value="private">{t('scope.private')}</option>
                <option value="shared">{t('scope.shared')}</option>
              </Select>
              <span className={'text-xs ' + (saveState === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')}>
                {saveState === 'saved' ? tb('allChangesSaved') : saveState === 'saving' ? tc('actions.saving') : saveState === 'error' ? tc('feedback.saveFailed') : tb('unsavedChanges')}
              </span>
            </div>
          ) : null}
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,360px)_1fr]">
          <div className="space-y-5">
            <div className={field}>
              <Label>{tb('source')}</Label>
              <Select value={query.entity} onChange={(e) => changeEntity(e.target.value)} disabled={!canCreate}>
                {REPORT_ENTITIES.map((e) => (
                  <option key={e.key} value={e.key}>
                    {tReports(`catalog.entities.${e.key}.label`)}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {tReports(`catalog.entities.${entity.key}.description`)}
              </p>
            </div>

            <div className={field}>
              <Label>{tb('mode')}</Label>
              <div className="flex gap-2">
                <Button type="button" variant={mode === 'rows' ? 'default' : 'outline'} size="sm" onClick={() => patch({ mode: 'rows' })} disabled={!canCreate}>
                  {tb('detailRows')}
                </Button>
                <Button
                  type="button"
                  variant={mode === 'summarize' ? 'default' : 'outline'}
                  size="sm"
                  disabled={!canCreate}
                  onClick={() => patch({ mode: 'summarize', measures: query.measures?.length ? query.measures : [{ fn: 'count' }] })}
                >
                  {tb('summarize')}
                </Button>
              </div>
            </div>

            {mode === 'rows' ? (
              <RowsConfig entity={entity} query={query} patch={patch} columns={selectableColumns} disabled={!canCreate} />
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

            <SortConfig entity={entity} query={query} patch={patch} disabled={!canCreate} />

            <div className={field}>
              <Label>{tb('rowLimit')}</Label>
              <Input
                type="number"
                min={1}
                max={10000}
                value={query.limit ?? 1000}
                onChange={(e) => patch({ limit: Math.min(Math.max(Number(e.target.value) || 1, 1), 10000) })}
                disabled={!canCreate}
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">{tb('rowLimitHint', { previewRows: 200 })}</p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{tb('livePreview')}</h2>
              <Button variant="outline" size="sm" disabled={previewing} onClick={() => runPreview(query)}>
                <Play size={14} /> {previewing ? tb('running') : tc('actions.refresh')}
              </Button>
            </div>
            {previewError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
                {previewError}
              </div>
            ) : preview ? (
              <ResultView company={company} title={name} description={description} result={preview} />
            ) : (
              <ReportPaper company={company} title={name} periodPhrase={description || undefined}>
                <p className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                  {previewing ? tb('runningPreview') : tb('previewEmptyHint')}
                </p>
              </ReportPaper>
            )}
          </div>
        </div>
      </div>
    </UrlDrawer>
  )
}
