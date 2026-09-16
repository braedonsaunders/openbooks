'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Drawer, Label, SearchSelect, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { PagedTable } from '../../../../../components/paged-table'
import { confirmDialog } from '../../../../../lib/confirm'
import { promptDialog } from '../../../../../lib/prompt'
import { LineagePanel } from '../../../../../components/allocations/LineagePanel'
import { shortId } from '../../../../../components/allocations/lineage-helpers'

interface Option {
  id: string
  label: string
  extra?: string
}

interface Options {
  rules: Option[]
  periods: Option[]
  books: Option[]
  subsidiaries: Option[]
}

interface RunRow {
  id: string
  ruleId: string
  ruleKey: string | null
  ruleName: string | null
  versionId: string
  periodId: string
  bookId: string
  subsidiaryId: string | null
  status: string
  triggerKind: string
  startedAt: string | null
  completedAt: string | null
  error: string | null
  sourceTotal: string
  allocatedTotal: string
  residual: string
  journalEntryId: string | null
  reversalEntryId: string | null
  requestedBy: string | null
  createdAt: string | null
}

interface Computation {
  ruleId: string
  versionId: string
  definitionHash: string
  periodId: string
  bookId: string
  subsidiaryId?: string | null
  sourceMeasure: string
  sources: { amount: string; lineCount: number; accountId: string }[]
  sourceTotal: string
  driver?: { id: string; key: string; vector: { key: string; value: string }[] } | null
  targets: { key: string; weight: string; share: string; amount: string; residual: string; label?: string | null }[]
  lines: { lineNumber: number; accountId: string; amount: string; memo?: string | null }[]
  residualPolicy: string
  impact: string
}

const STATUSES = ['previewed', 'pending_approval', 'posted', 'reversed', 'failed', 'superseded'] as const

function optionLabel(options: Option[], id: string | null): string {
  if (!id) return ''
  return options.find((o) => o.id === id)?.label ?? shortId(id)
}

function ComputationView({ computation }: { computation: Computation }) {
  const t = useTranslations('allocations.runs')
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-medium">{t('sources')}</h4>
        {computation.sources.length === 0 ? (
          <p className="text-sm text-slate-500">{t('computationEmpty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('account')}</TableHead>
                <TableHead className="text-right">{t('amount')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {computation.sources.map((s, i) => (
                <TableRow key={i}>
                  <TableCell className="tabular-nums">{shortId(s.accountId)}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.amount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {computation.driver ? (
        <div>
          <h4 className="text-sm font-medium">{t('driverVector')}</h4>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('target')}</TableHead>
                <TableHead className="text-right">{t('weight')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {computation.driver.vector.map((v) => (
                <TableRow key={v.key}>
                  <TableCell className="tabular-nums">{shortId(v.key)}</TableCell>
                  <TableCell className="text-right tabular-nums">{v.value}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      <div>
        <h4 className="text-sm font-medium">{t('targets')}</h4>
        {computation.targets.length === 0 ? (
          <p className="text-sm text-slate-500">{t('computationEmpty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('target')}</TableHead>
                <TableHead className="text-right">{t('weight')}</TableHead>
                <TableHead className="text-right">{t('share')}</TableHead>
                <TableHead className="text-right">{t('amount')}</TableHead>
                <TableHead className="text-right">{t('residual')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {computation.targets.map((target) => (
                <TableRow key={target.key}>
                  <TableCell>{target.label ?? shortId(target.key)}</TableCell>
                  <TableCell className="text-right tabular-nums">{target.weight}</TableCell>
                  <TableCell className="text-right tabular-nums">{target.share}</TableCell>
                  <TableCell className="text-right tabular-nums">{target.amount}</TableCell>
                  <TableCell className="text-right tabular-nums">{target.residual}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {computation.lines.length > 0 ? (
        <div>
          <h4 className="text-sm font-medium">{t('lines')}</h4>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('account')}</TableHead>
                <TableHead>{t('memo')}</TableHead>
                <TableHead className="text-right">{t('amount')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {computation.lines.map((line) => (
                <TableRow key={line.lineNumber}>
                  <TableCell className="tabular-nums">{shortId(line.accountId)}</TableCell>
                  <TableCell>{line.memo ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{line.amount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Runs tab (A8): filtered run list, run preview (rule + period + book),
 * run detail drawer with the stored RunComputation, lineage drill and the
 * Post / Reverse / Re-run actions (reason prompts; allocations.run +
 * gl.post enforced server-side; 503 until A3's engine lands).
 */
export function RunsTab() {
  const t = useTranslations('allocations.runs')
  const tc = useTranslations('common')
  const [options, setOptions] = useState<Options | null>(null)
  const [runs, setRuns] = useState<RunRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [filterRule, setFilterRule] = useState('')
  const [filterPeriod, setFilterPeriod] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [previewForm, setPreviewForm] = useState({ ruleId: '', periodId: '', bookId: '', subsidiaryId: '' })
  const [preview, setPreview] = useState<Computation | null>(null)
  const [detail, setDetail] = useState<(RunRow & { computation?: Computation; fingerprint?: string | null }) | null>(null)

  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams()
    if (filterRule) params.set('ruleId', filterRule)
    if (filterPeriod) params.set('periodId', filterPeriod)
    if (filterStatus) params.set('status', filterStatus)
    Promise.all([fetch(`/api/allocations/runs?${params}`), fetch('/api/allocations/options')]).then(
      async ([runsRes, optionsRes]) => {
        if (cancelled) return
        if (!runsRes.ok || !optionsRes.ok) {
          setError(t('loadFailed'))
          return
        }
        setError(null)
        const body = (await runsRes.json()) as { runs: RunRow[]; total: number }
        if (cancelled) return
        setRuns(body.runs)
        setTotal(body.total)
        const full = (await optionsRes.json()) as Options & Record<string, Option[]>
        setOptions({ rules: full.rules, periods: full.periods, books: full.books, subsidiaries: full.subsidiaries })
      },
      () => {
        if (!cancelled) setError(t('loadFailed'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [filterRule, filterPeriod, filterStatus, t, reloadKey])

  async function runPreview() {
    setPreview(null)
    setNotice(null)
    const res = await fetch('/api/allocations/runs/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ruleId: previewForm.ruleId,
        periodId: previewForm.periodId,
        bookId: previewForm.bookId,
        subsidiaryId: previewForm.subsidiaryId || null,
      }),
    })
    const json = (await res.json().catch(() => ({}))) as { computation?: Computation; errorCode?: string; error?: string }
    if (!res.ok) {
      setNotice(res.status === 503 ? t('enginePending') : (json.error ?? t('loadFailed')))
      return
    }
    if (json.computation) setPreview(json.computation)
  }

  async function openDetail(id: string) {
    const res = await fetch(`/api/allocations/runs/${id}`)
    if (!res.ok) {
      setError(t('detailFailed'))
      return
    }
    setDetail(((await res.json()) as { run: RunRow & { computation?: Computation } }).run)
  }

  async function act(kind: 'post' | 'reverse' | 'rerun') {
    if (!detail) return
    setNotice(null)
    let body: Record<string, unknown> = {}
    if (kind === 'post' || kind === 'reverse') {
      const reason = await promptDialog({ title: t(kind === 'post' ? 'postReasonPrompt' : 'reverseReasonPrompt') })
      if (!reason) {
        setNotice(t('reasonRequired'))
        return
      }
      body = { reason }
    } else {
      if (!(await confirmDialog(t('rerun')))) return
    }
    const res = await fetch(`/api/allocations/runs/${detail.id}/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as { errorCode?: string; error?: string }
    if (!res.ok) {
      setNotice(
        res.status === 503
          ? t('enginePending')
          : (json.error ?? t(kind === 'post' ? 'postFailed' : kind === 'reverse' ? 'reverseFailed' : 'rerunFailed')),
      )
      return
    }
    reload()
    await openDetail(detail.id)
  }

  if (!runs || !options) return <p className="text-sm text-slate-500">{error ?? '…'}</p>

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">{t('title')}</h3>
        <p className="text-sm text-slate-500">{t('description')}</p>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {notice ? <p className="text-sm text-slate-500">{notice}</p> : null}

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label>{t('filterRule')}</Label>
          <SearchSelect
            value={filterRule}
            onChange={(v) => setFilterRule(v ?? '')}
            options={options.rules.map((r) => ({ value: r.id, label: r.label }))}
            placeholder={t('all')}
            clearable
            emptyLabel={t('all')}
          />
        </div>
        <div>
          <Label>{t('filterPeriod')}</Label>
          <SearchSelect
            value={filterPeriod}
            onChange={(v) => setFilterPeriod(v ?? '')}
            options={options.periods.map((p) => ({ value: p.id, label: p.label }))}
            placeholder={t('all')}
            clearable
            emptyLabel={t('all')}
          />
        </div>
        <div>
          <Label>{t('filterStatus')}</Label>
          <Select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="">{t('all')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`statuses.${s}`)}
              </option>
            ))}
          </Select>
        </div>
        <span className="text-sm text-slate-500">
          {total} · {t('title')}
        </span>
      </div>

      <PagedTable
        rows={runs}
        rowKey={(row) => row.id}
        empty={<p className="text-sm text-slate-500">{t('empty')}</p>}
        onRowClick={(row) => void openDetail(row.id)}
        columns={[
          { key: 'rule', header: t('columns.rule'), cell: (row) => row.ruleName ?? row.ruleKey ?? shortId(row.ruleId), search: (row) => row.ruleName ?? row.ruleKey ?? '' },
          { key: 'period', header: t('columns.period'), cell: (row) => optionLabel(options.periods, row.periodId) },
          { key: 'book', header: t('columns.book'), cell: (row) => optionLabel(options.books, row.bookId) },
          {
            key: 'subsidiary',
            header: t('columns.subsidiary'),
            cell: (row) => (row.subsidiaryId ? optionLabel(options.subsidiaries, row.subsidiaryId) : t('allSubsidiaries')),
          },
          { key: 'status', header: t('columns.status'), cell: (row) => t(`statuses.${row.status}`) },
          { key: 'source', header: t('columns.sourceTotal'), align: 'right', cell: (row) => <span className="tabular-nums">{row.sourceTotal}</span> },
          { key: 'allocated', header: t('columns.allocated'), align: 'right', cell: (row) => <span className="tabular-nums">{row.allocatedTotal}</span> },
          { key: 'residual', header: t('columns.residual'), align: 'right', cell: (row) => <span className="tabular-nums">{row.residual}</span> },
          {
            key: 'journal',
            header: t('columns.journal'),
            cell: (row) => (row.journalEntryId ? <span className="tabular-nums">{shortId(row.journalEntryId)}</span> : '—'),
          },
          {
            key: 'requestedBy',
            header: t('columns.requestedBy'),
            cell: (row) => (row.requestedBy ? <span className="tabular-nums">{shortId(row.requestedBy)}</span> : '—'),
          },
          {
            key: 'created',
            header: t('columns.created'),
            cell: (row) => (row.createdAt ? <span className="tabular-nums">{row.createdAt.slice(0, 10)}</span> : '—'),
          },
        ]}
      />

      <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <h4 className="text-sm font-medium">{t('previewRun')}</h4>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label>{t('filterRule')}</Label>
            <SearchSelect
              value={previewForm.ruleId}
              onChange={(v) => setPreviewForm((f) => ({ ...f, ruleId: v ?? '' }))}
              options={options.rules.map((r) => ({ value: r.id, label: r.label }))}
              placeholder={t('filterRule')}
            />
          </div>
          <div>
            <Label>{t('filterPeriod')}</Label>
            <SearchSelect
              value={previewForm.periodId}
              onChange={(v) => setPreviewForm((f) => ({ ...f, periodId: v ?? '' }))}
              options={options.periods.map((p) => ({ value: p.id, label: p.label }))}
              placeholder={t('filterPeriod')}
            />
          </div>
          <div>
            <Label>{t('columns.book')}</Label>
            <SearchSelect
              value={previewForm.bookId}
              onChange={(v) => setPreviewForm((f) => ({ ...f, bookId: v ?? '' }))}
              options={options.books.map((b) => ({ value: b.id, label: b.label }))}
              placeholder={t('columns.book')}
            />
          </div>
          <div>
            <Label>{t('columns.subsidiary')}</Label>
            <SearchSelect
              value={previewForm.subsidiaryId}
              onChange={(v) => setPreviewForm((f) => ({ ...f, subsidiaryId: v ?? '' }))}
              options={options.subsidiaries.map((s) => ({ value: s.id, label: s.label }))}
              placeholder={t('allSubsidiaries')}
              clearable
              emptyLabel={t('allSubsidiaries')}
            />
          </div>
          <Button
            type="button"
            onClick={() => void runPreview()}
            disabled={!previewForm.ruleId || !previewForm.periodId || !previewForm.bookId}
          >
            {t('previewRun')}
          </Button>
        </div>
        {preview ? <ComputationView computation={preview} /> : null}
      </div>

      <Drawer open={detail !== null} onClose={() => setDetail(null)} title={t('runDetail')} size="xl">
        {detail ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <span className="text-slate-500">{t('columns.rule')}</span>
              <span>{detail.ruleName ?? detail.ruleKey ?? shortId(detail.ruleId)}</span>
              <span className="text-slate-500">{t('columns.status')}</span>
              <span>{t(`statuses.${detail.status}`)}</span>
              <span className="text-slate-500">{t('columns.sourceTotal')}</span>
              <span className="tabular-nums">{detail.sourceTotal}</span>
              <span className="text-slate-500">{t('columns.allocated')}</span>
              <span className="tabular-nums">{detail.allocatedTotal}</span>
              <span className="text-slate-500">{t('columns.residual')}</span>
              <span className="tabular-nums">{detail.residual}</span>
              <span className="text-slate-500">{t('journalEntry')}</span>
              <span className="tabular-nums">{detail.journalEntryId ? shortId(detail.journalEntryId) : '—'}</span>
              <span className="text-slate-500">{t('reversalEntry')}</span>
              <span className="tabular-nums">{detail.reversalEntryId ? shortId(detail.reversalEntryId) : '—'}</span>
              <span className="text-slate-500">{t('definitionHash')}</span>
              <span className="tabular-nums">{shortId(detail.computation?.definitionHash ?? null)}</span>
              <span className="text-slate-500">{t('version')}</span>
              <span className="tabular-nums">{shortId(detail.versionId)}</span>
              <span className="text-slate-500">{t('trigger')}</span>
              <span>{detail.triggerKind}</span>
              <span className="text-slate-500">{t('started')}</span>
              <span className="tabular-nums">{detail.startedAt ?? '—'}</span>
              <span className="text-slate-500">{t('completed')}</span>
              <span className="tabular-nums">{detail.completedAt ?? '—'}</span>
              {detail.error ? (
                <>
                  <span className="text-slate-500">{t('runError')}</span>
                  <span className="text-red-600">{detail.error}</span>
                </>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={() => void act('post')}>
                {t('post')}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void act('reverse')}>
                {t('reverse')}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void act('rerun')}>
                {t('rerun')}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setDetail(null)}>
                {tc('close')}
              </Button>
            </div>
            {detail.computation ? <ComputationView computation={detail.computation} /> : null}
            <LineagePanel anchor={{ runId: detail.id }} />
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}
