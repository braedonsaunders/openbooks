'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { Button, Label, SearchSelect, Textarea } from '@openbooks/ui'
import type { ProcessDetail } from '@openbooks/engine/hrm/processes'
import { actionableChecklistSteps } from '@openbooks/forms-core'
import { Check, ClipboardList, Clock3, LockKeyhole } from 'lucide-react'
import {
  BuilderSplit,
  OutlinePanel,
  OutlineRow,
  InspectorPanel,
} from '../../../components/builder/builder-kit'
import { ChecklistStepContent } from '../../../components/checklist-step-content'
import { useDirtyUrlDrawer } from '../../../components/dirty-url-drawer'
import { useAppAction } from '../../../lib/use-app-action'

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

export function ProcessChecklistBody({ detail }: { detail: ProcessDetail }) {
  const t = useTranslations('hrm')
  const td = useTranslations('hrm.processes.designer')
  const [selectedId, setSelectedId] = useState(
    actionableChecklistSteps(
      detail.steps.map((s) => ({ ...s, sourceStepId: s.sourceStepId ?? null })),
    )[0]?.id ??
      detail.steps[0]?.id ??
      '',
  )
  const selected = detail.steps.find((s) => s.id === selectedId) ?? detail.steps[0]
  const [responses, setResponses] = useState<Record<string, Record<string, unknown>>>({})
  const [acknowledgements, setAcknowledgements] = useState<Record<string, boolean>>({})
  const [attachments, setAttachments] = useState<Record<string, string>>({})
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  // Shared action path: the refusal toasts through the hook and renders
  // inline, and busy always releases — a dead network can never wedge it.
  const { busy, execute } = useAppAction()
  const [reason, setReason] = useState('')
  const [reasonFor, setReasonFor] = useState<{ action: 'skip' | 'cancel'; stepId?: string } | null>(
    null,
  )
  const attachmentId = selected ? (attachments[selected.id] ?? selected.attachmentId ?? '') : ''
  const setAttachmentId = (value: string) => {
    if (selected) setAttachments((v) => ({ ...v, [selected.id]: value }))
  }
  const [fileOptions, setFileOptions] = useState<{ query: string; options: FileOption[] } | null>(
    null,
  )
  const [fileLoadError, setFileLoadError] = useState<{ query: string; message: string } | null>(
    null,
  )
  const [fileQuery, setFileQuery] = useState('')

  const normalizedFileQuery = fileQuery.trim()
  // Results and failures belong to the query that produced them. This also
  // hides stale options on the render before the next effect runs.
  const visibleFileOptions =
    normalizedFileQuery.length < 2 || fileOptions?.query !== normalizedFileQuery
      ? []
      : fileOptions.options
  const visibleFileLoadError =
    fileLoadError?.query === normalizedFileQuery ? fileLoadError.message : null
  useEffect(() => {
    if (normalizedFileQuery.length < 2) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/file-cabinet/files?q=${encodeURIComponent(normalizedFileQuery)}&perPage=20`,
        )
        if (!res.ok) throw new Error('file search failed')
        const data = (await res.json()) as { files?: { id: string; name?: string }[] }
        if (!Array.isArray(data.files)) throw new Error('file search returned invalid data')
        if (!cancelled) {
          setFileOptions({
            query: normalizedFileQuery,
            options: data.files.map((file) => ({ value: file.id, label: file.name ?? file.id })),
          })
          setFileLoadError(null)
        }
      } catch {
        if (!cancelled)
          setFileLoadError({ query: normalizedFileQuery, message: t('processes.fileSearchFailed') })
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [normalizedFileQuery, t])

  async function mutate(url: string, body: unknown): Promise<boolean> {
    setError(null)
    return execute(
      () =>
        fetchAction(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      {
        fallbackMessage: t('processes.actionFailed'),
        onOk: () => {
          setReason('')
          setReasonFor(null)
          if (selected) {
            setResponses((v) => {
              const next = { ...v }
              delete next[selected.id]
              return next
            })
            setAttachments((v) => {
              const next = { ...v }
              delete next[selected.id]
              return next
            })
            setAcknowledgements((v) => {
              const next = { ...v }
              delete next[selected.id]
              return next
            })
          }
          router.refresh()
        },
        onRefused: (actionError) =>
          setError(actionError.displayMessage(t('processes.actionFailed'))),
      },
    )
  }

  const isOpen = detail.status === 'open'
  useDirtyUrlDrawer(
    Object.keys(responses).length > 0 ||
      Object.keys(attachments).length > 0 ||
      Object.values(acknowledgements).some(Boolean),
    busy,
  )
  const blocked =
    selected?.blocked === true
      ? [undefined]
      : selected?.blocked === false
        ? []
        : (selected?.design?.dependencies
            .map((id) => detail.steps.find((s) => s.sourceStepId === id))
            .filter((s) => !s || s.status === 'pending') ?? [])
  const locked =
    !isOpen ||
    selected?.status !== 'pending' ||
    selected?.approvalStatus === 'pending' ||
    selected?.approvalStatus === 'approved'
  const response = selected ? (responses[selected.id] ?? selected.response ?? {}) : {}

  return (
    <div className="space-y-4">
      {error !== null ? (
        <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : null}
      {visibleFileLoadError !== null ? (
        <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">
          {visibleFileLoadError}
        </p>
      ) : null}
      {detail.effectiveDate ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t('processes.progressLine', {
            done: detail.progress.doneRequired,
            required: detail.progress.required,
            effective: detail.effectiveDate,
          })}
        </p>
      ) : null}
      <BuilderSplit
        outline={
          <OutlinePanel title={detail.workerName || t('processes.newChecklist')}>
            {detail.steps.map((step, index) => (
              <div key={step.id}>
                {step.design?.section &&
                (index === 0 ||
                  detail.steps[index - 1]?.design?.section !== step.design.section) ? (
                  <p className="px-3 pb-1 pt-4 text-xs font-semibold uppercase text-slate-400">
                    {step.design.section}
                  </p>
                ) : null}
                <OutlineRow
                  selected={selected?.id === step.id}
                  icon={
                    step.status === 'done' ? (
                      <Check size={16} />
                    ) : step.overdue ? (
                      <Clock3 size={16} />
                    ) : (
                      <span className="text-xs">{index + 1}</span>
                    )
                  }
                  label={step.title}
                  meta={t(`processes.owners.${step.ownerKind}`) + ' · ' + step.dueOn}
                  onSelect={() => {
                    setSelectedId(step.id)
                    setReasonFor(null)
                    setError(null)
                  }}
                  trailing={
                    <span
                      className={step.overdue ? 'text-xs text-red-600' : 'text-xs text-slate-400'}
                    >
                      {t(`processes.stepStatus.${step.status}`)}
                    </span>
                  }
                />
              </div>
            ))}
          </OutlinePanel>
        }
      >
        {selected ? (
          <InspectorPanel
            icon={<ClipboardList size={18} />}
            eyebrow={
              t(`processes.owners.${selected.ownerKind}`) +
              ' · ' +
              t('processes.dueOn', { date: selected.dueOn })
            }
            title={selected.title}
          >
            {blocked.length ? (
              <p className="flex items-center gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                <LockKeyhole size={15} />
                {td('blocked')}: {blocked.map((s) => s?.title ?? '—').join(', ')}
              </p>
            ) : null}
            {selected.approvalStatus === 'pending' ? (
              <p className="text-sm text-amber-700">
                {td('approvalPending')} ·{' '}
                <a href="/inbox" className="underline">
                  {td('approvalWorklist')}
                </a>
              </p>
            ) : null}
            {selected.approvalStatus === 'approved' ? (
              <p className="text-sm text-teal-700">{td('approved')}</p>
            ) : null}
            {selected.approvalStatus === 'rejected' ? (
              <p className="text-sm text-red-600">{td('rejected')}</p>
            ) : null}
            <ChecklistStepContent
              step={selected}
              values={response}
              onChange={(key, value) =>
                setResponses((v) => ({ ...v, [selected.id]: { ...response, [key]: value } }))
              }
              acknowledged={
                acknowledgements[selected.id] ??
                (selected.status === 'done' ||
                  selected.approvalStatus === 'approved' ||
                  selected.approvalStatus === 'pending')
              }
              onAcknowledge={(value) =>
                setAcknowledgements((v) => ({ ...v, [selected.id]: value }))
              }
              disabled={locked || busy}
              attachment={
                selected.evidenceKind === 'attachment' ? (
                  <div className="space-y-2">
                    <Label htmlFor={`file-${selected.id}`}>{t('processes.attachmentLabel')}</Label>
                    <SearchSelect
                      id={`file-${selected.id}`}
                      value={attachmentId}
                      onChange={setAttachmentId}
                      options={visibleFileOptions}
                      ariaLabel={t('processes.attachmentLabel')}
                      sheetTitle={t('processes.attachmentLabel')}
                      clearable
                      emptyLabel={t('processes.attachmentUnset')}
                      disabled={locked || busy}
                      remote
                      onSearchChange={setFileQuery}
                    />
                  </div>
                ) : null
              }
            />
            {isOpen && selected.status === 'pending' && selected.canComplete !== false ? (
              <div className="flex flex-wrap gap-2 border-t pt-4">
                <Button
                  disabled={
                    busy ||
                    blocked.length > 0 ||
                    selected.approvalStatus === 'pending' ||
                    (selected.evidenceKind === 'acknowledgement' &&
                      !(acknowledgements[selected.id] ?? selected.approvalStatus === 'approved')) ||
                    (selected.evidenceKind === 'attachment' && !attachmentId)
                  }
                  onClick={() =>
                    void mutate(
                      `/api/hrm/processes/steps/${selected.id}/${selected.design?.approval && selected.approvalStatus !== 'approved' ? 'submit' : 'complete'}`,
                      {
                        ...(selected.evidenceKind === 'attachment' ? { attachmentId } : {}),
                        ...(selected.evidenceKind === 'acknowledgement'
                          ? {
                              acknowledged:
                                acknowledgements[selected.id] ??
                                selected.approvalStatus === 'approved',
                            }
                          : {}),
                        ...(selected.design?.form ? { response } : {}),
                      },
                    )
                  }
                >
                  {selected.design?.approval && selected.approvalStatus !== 'approved'
                    ? td('submitApproval')
                    : t('processes.completeStep')}
                </Button>
                {selected.canSkip !== false ? (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setReasonFor({ action: 'skip', stepId: selected.id })}
                  >
                    {t('processes.skipStep')}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {selected.status !== 'pending' ? (
              <div className="rounded-lg bg-slate-50 p-4 text-sm dark:bg-slate-800/50">
                <p className="font-medium">{td('history')}</p>
                <p>
                  {t(`processes.stepStatus.${selected.status}`)}
                  {selected.doneAt ? ' · ' + td('doneAt', { date: selected.doneAt }) : ''}
                </p>
                {selected.doneByName ? (
                  <p className="text-xs text-slate-500">{selected.doneByName}</p>
                ) : null}
                {selected.skipReason ? <p>{selected.skipReason}</p> : null}
                {isOpen && detail.steps.some((s) => s.status === 'pending') ? (
                  <Button
                    className="mt-3"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setSelectedId(
                        actionableChecklistSteps(
                          detail.steps.map((s) => ({ ...s, sourceStepId: s.sourceStepId ?? null })),
                        )[0]?.id ?? detail.steps.find((s) => s.status === 'pending')!.id,
                      )
                    }
                  >
                    {td('nextStep')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </InspectorPanel>
        ) : null}
      </BuilderSplit>
      {isOpen && detail.canManage !== false ? (
        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          <Button
            size="sm"
            variant="default"
            disabled={busy || !detail.progress.allRequiredDone}
            onClick={() => void mutate(`/api/hrm/processes/${detail.id}/complete`, {})}
          >
            {t('processes.completeProcess')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setReasonFor({ action: 'cancel' })}
          >
            {t('processes.cancelProcess')}
          </Button>
        </div>
      ) : null}
      {reasonFor !== null ? (
        <div className="space-y-1.5 rounded-lg border border-slate-100 p-3 dark:border-slate-800">
          <Label htmlFor="process-reason">
            {reasonFor.action === 'cancel'
              ? t('processes.cancelReasonLabel')
              : t('processes.skipReasonLabel')}
          </Label>
          <Textarea
            id="process-reason"
            value={reason}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            placeholder={
              reasonFor.action === 'cancel'
                ? t('processes.cancelReasonPlaceholder')
                : t('processes.skipReasonPlaceholder')
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
