'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, Label, SearchSelect, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../lib/api-error'

/**
 * Process checklists list with segments and the checklist drawer. Opens
 * from the /hrm strip behind hrm.process.read (the API re-checks every
 * grant): segments switch the collection query, rows show employee, kind,
 * effective date, progress, and next due, and the drawer carries owners,
 * due dates, evidence, and the complete/skip actions with their refusals.
 *
 * Every API refusal renders with its message intact — res.ok is checked
 * before parsing, failures toast and render inline, and nothing is
 * swallowed. Civil dates travel verbatim, never through a Date.
 */

type Segment = 'open' | 'overdue' | 'completed' | 'cancelled'

const SEGMENTS: Segment[] = ['open', 'overdue', 'completed', 'cancelled']

export type ProcessListRow = {
  id: string
  kind: string
  effectiveDate: string
  status: string
  workerName: string
  total: number
  required: number
  doneRequired: number
  overdueSteps: number
  nextDueOn: string | null
}

export type ProcessStepRow = {
  id: string
  position: number
  title: string
  description: string | null
  ownerKind: string
  dueOn: string
  required: boolean
  evidenceKind: string
  status: string
  overdue: boolean
  attachmentId: string | null
}

export type ProcessDetailRow = {
  id: string
  kind: string
  effectiveDate: string
  status: string
  workerName: string
  progress: { total: number; required: number; doneRequired: number; allRequiredDone: boolean }
  steps: ProcessStepRow[]
}

type FileOption = { value: string; label: string }

async function readError(res: Response, fallback: string): Promise<string> {
  return readApiErrorMessage(res, fallback)
}

export function ProcessesPanel() {
  const t = useTranslations('hrm')
  const [segment, setSegment] = useState<Segment>('open')
  const [rows, setRows] = useState<ProcessListRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async (next: Segment) => {
    setLoading(true)
    setError(null)
    const res = await fetch(`/api/hrm/processes?segment=${next}`)
    setLoading(false)
    if (!res.ok) {
      setError(await readError(res, t('processes.listFailed')))
      setRows([])
      return
    }
    const data = (await res.json().catch(() => ({}))) as { processes?: ProcessListRow[] }
    setRows(Array.isArray(data.processes) ? data.processes : [])
  }, [t])

  useEffect(() => {
    void load(segment)
  }, [load, segment])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800" role="tablist">
        {SEGMENTS.map((next) => (
          <Button
            key={next}
            role="tab"
            aria-selected={segment === next}
            variant={segment === next ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setSegment(next)}
          >
            {t(`processes.segments.${next}`)}
          </Button>
        ))}
      </div>
      {error !== null ? (
        <p className="px-4 py-6 text-center text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : loading ? (
        <p className="px-4 py-6 text-center text-sm text-slate-400">{t('processes.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">{t('processes.empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
            <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <th className="px-4 py-2 text-left font-medium">{t('processes.columns.employee')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('processes.columns.kind')}</th>
              <th className="px-3 py-2 text-left font-medium">{t('processes.columns.effective')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('processes.columns.progress')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('processes.columns.nextDue')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40"
                onClick={() => setOpenId(row.id)}
              >
                <td className="px-4 py-2 font-medium text-slate-700 dark:text-slate-200">{row.workerName}</td>
                <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{t(`processes.kinds.${row.kind}`)}</td>
                <td className="px-3 py-2 tabular-nums text-slate-500 dark:text-slate-400">{row.effectiveDate}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-200">
                  {row.doneRequired}/{row.required}
                  {row.overdueSteps > 0 ? (
                    <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300">
                      {t('processes.overdueBadge', { count: row.overdueSteps })}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                  {row.nextDueOn ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {openId !== null ? (
        <ProcessDrawer
          processId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => void load(segment)}
        />
      ) : null}
    </div>
  )
}

function ProcessDrawer({
  processId,
  onClose,
  onChanged,
}: {
  processId: string
  onClose: () => void
  onChanged: () => void
}) {
  const t = useTranslations('hrm')
  const [detail, setDetail] = useState<ProcessDetailRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonFor, setReasonFor] = useState<{ action: 'skip' | 'cancel'; stepId?: string } | null>(null)
  const [attachmentId, setAttachmentId] = useState('')
  const [fileOptions, setFileOptions] = useState<FileOption[]>([])
  const [fileQuery, setFileQuery] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const res = await fetch(`/api/hrm/processes/${processId}`)
    setLoading(false)
    if (!res.ok) {
      setError(await readError(res, t('processes.detailFailed')))
      setDetail(null)
      return
    }
    const data = (await res.json().catch(() => ({}))) as { process?: ProcessDetailRow }
    if (!data.process || typeof data.process !== 'object') {
      setError(t('processes.detailFailed'))
      setDetail(null)
      return
    }
    setDetail(data.process)
  }, [processId, t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (fileQuery.length < 2) {
      setFileOptions([])
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/file-cabinet/files?q=${encodeURIComponent(fileQuery)}&perPage=20`)
      if (!res.ok || cancelled) return
      const data = (await res.json().catch(() => ({}))) as { files?: { id: string; name?: string }[] }
      if (!cancelled && Array.isArray(data.files)) {
        setFileOptions(data.files.map((file) => ({ value: file.id, label: file.name ?? file.id })))
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [fileQuery])

  async function mutate(url: string, body: unknown): Promise<boolean> {
    setBusy(true)
    setError(null)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    setBusy(false)
    if (!res.ok) {
      const message = await readError(res, t('processes.actionFailed'))
      setError(message)
      toast.error(message)
      return false
    }
    setReason('')
    setReasonFor(null)
    setAttachmentId('')
    onChanged()
    await load()
    return true
  }

  const isOpen = detail !== null && detail.status === 'open'

  return (
    <Drawer title={detail ? `${detail.workerName} · ${t(`processes.kinds.${detail.kind}`)}` : t('processes.detailTitle')} onClose={onClose} wide>
      {error !== null ? <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {loading || detail === null ? (
        <p className="py-6 text-center text-sm text-slate-400">{t('processes.loading')}</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t('processes.progressLine', {
              done: detail.progress.doneRequired,
              required: detail.progress.required,
              effective: detail.effectiveDate,
            })}
          </p>
          <ol className="space-y-3">
            {detail.steps.map((step) => (
              <li key={step.id} className="rounded-lg border border-slate-100 p-3 dark:border-slate-800">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{step.title}</p>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {t(`processes.owners.${step.ownerKind}`)} · {t('processes.dueOn', { date: step.dueOn })}
                      {step.required ? ` · ${t('processes.required')}` : ''}
                      {step.evidenceKind !== 'none' ? ` · ${t(`processes.evidence.${step.evidenceKind}`)}` : ''}
                    </p>
                    {step.description ? (
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{step.description}</p>
                    ) : null}
                  </div>
                  <span
                    className={
                      step.status === 'done'
                        ? 'rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                        : step.status === 'skipped'
                          ? 'rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                          : step.overdue
                            ? 'rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300'
                            : 'rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                    }
                  >
                    {t(`processes.stepStatus.${step.status}`)}
                  </span>
                </div>
                {isOpen && step.status === 'pending' ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {step.evidenceKind === 'attachment' ? (
                      <div className="min-w-52 flex-1 space-y-1.5">
                        <Label htmlFor={`file-${step.id}`}>{t('processes.attachmentLabel')}</Label>
                        <SearchSelect
                          id={`file-${step.id}`}
                          value={attachmentId}
                          onChange={(next) => setAttachmentId(next)}
                          options={fileOptions}
                          ariaLabel={t('processes.attachmentLabel')}
                          sheetTitle={t('processes.attachmentLabel')}
                          clearable
                          emptyLabel={t('processes.attachmentUnset')}
                          disabled={busy}
                          onSearchChange={(next) => setFileQuery(next)}
                        />
                      </div>
                    ) : null}
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          `/api/hrm/processes/steps/${step.id}/complete`,
                          step.evidenceKind === 'attachment' ? { attachmentId } : {},
                        )
                      }
                    >
                      {t('processes.completeStep')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setReasonFor({ action: 'skip', stepId: step.id })}
                    >
                      {t('processes.skipStep')}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
          {isOpen ? (
            <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void mutate(`/api/hrm/processes/${detail.id}/complete`, {})}>
                {t('processes.completeProcess')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReasonFor({ action: 'cancel' })}>
                {t('processes.cancelProcess')}
              </Button>
            </div>
          ) : null}
          {reasonFor !== null ? (
            <div className="space-y-1.5 rounded-lg border border-slate-100 p-3 dark:border-slate-800">
              <Label htmlFor="process-reason">
                {reasonFor.action === 'cancel' ? t('processes.cancelReasonLabel') : t('processes.skipReasonLabel')}
              </Label>
              <Textarea
                id="process-reason"
                value={reason}
                disabled={busy}
                onChange={(event) => setReason(event.target.value)}
                placeholder={
                  reasonFor.action === 'cancel' ? t('processes.cancelReasonPlaceholder') : t('processes.skipReasonPlaceholder')
                }
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || reason.trim().length === 0}
                  onClick={() =>
                    void mutate(
                      reasonFor.action === 'cancel'
                        ? `/api/hrm/processes/${detail.id}/cancel`
                        : `/api/hrm/processes/steps/${reasonFor.stepId}/skip`,
                      { reason: reason.trim() },
                    )
                  }
                >
                  {t('processes.confirmReason')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReasonFor(null)}>
                  {t('processes.cancelReasonAbort')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Drawer>
  )
}
