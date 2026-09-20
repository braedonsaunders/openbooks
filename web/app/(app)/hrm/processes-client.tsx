'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Label, SearchSelect, Textarea } from '@openbooks/ui'
import type { ProcessDetail } from '@openbooks/engine/src/hrm/processes-read.ts'
import { readApiErrorMessage } from '../../../lib/api-error'

/**
 * The checklist drawer body: owners, due dates, evidence, and the
 * complete/skip actions with their refusals. Renders the loader-resolved
 * detail it is given (no org id crosses into render) and refreshes the
 * server data after every mutation.
 *
 * Shared by the /hrm/processes page and the hrm-process-drawer widget via
 * ./processes/sections so they cannot drift. Opens from the /hrm strip
 * behind hrm.process.read (the API re-checks every grant).
 *
 * Every API refusal renders with its message intact — res.ok is checked
 * before parsing, failures toast and render inline, and nothing is
 * swallowed. Civil dates travel verbatim, never through a Date.
 */

type FileOption = { value: string; label: string }

async function readError(res: Response, fallback: string): Promise<string> {
  return readApiErrorMessage(res, fallback)
}

export function ProcessChecklistBody({ detail }: { detail: ProcessDetail }) {
  const t = useTranslations('hrm')
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonFor, setReasonFor] = useState<{ action: 'skip' | 'cancel'; stepId?: string } | null>(null)
  const [attachmentId, setAttachmentId] = useState('')
  const [fileOptions, setFileOptions] = useState<FileOption[]>([])
  const [fileQuery, setFileQuery] = useState('')

  // Options are only meaningful for a query of two or more characters; the
  // render derives that instead of an effect clearing state synchronously.
  const visibleFileOptions = fileQuery.length < 2 ? [] : fileOptions
  useEffect(() => {
    if (fileQuery.length < 2) return
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
    router.refresh()
    return true
  }

  const isOpen = detail.status === 'open'

  return (
    <div className="space-y-4">
      {error !== null ? <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
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
                      options={visibleFileOptions}
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
          <Button size="sm" variant="default" disabled={busy} onClick={() => void mutate(`/api/hrm/processes/${detail.id}/complete`, {})}>
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
              variant="default"
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
  )
}
