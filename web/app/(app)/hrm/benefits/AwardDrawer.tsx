'use client'

import Link from 'next/link'
import { useEffect, useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { promptDialog } from '../../../../lib/prompt'
import { ApprovalHistory } from '../../../../components/approval-history'
import { useDirtyClose } from '../../../../lib/use-dirty-close'
import { awardResourceUrl } from '../../../../lib/hrm/benefits-portfolio'
import type { AwardDetailDrawer } from '../../../../lib/hrm/benefits-workspace'

/**
 * Award detail drawer, opened from a row through the `award=<id>` search
 * param. The award's program, recipient, period, and value render the
 * stored figures — never recomputed. Each lifecycle move rides the
 * benefit-awards route with the grant its service enforces: submit for HR,
 * native Flows for configured direct or staged approval, finance queueing,
 * then confirmation of a native payroll adjustment
 * from its committed run. The list refreshes after every
 * transition; delivered and voided history stays terminal.
 */
export function AwardDrawer({
  drawer,
  closeHref,
  canManage,
  canQueue,
}: {
  drawer: AwardDetailDrawer
  closeHref: string
  canManage: boolean
  canQueue: boolean
}) {
  const t = useTranslations('hrm')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const refId = useId()
  const [working, setWorking] = useState(false)
  const [externalRef, setExternalRef] = useState('')
  const [enteringRef, setEnteringRef] = useState(false)
  const [queueing, setQueueing] = useState(false)
  const [runId, setRunId] = useState('')
  const [runs, setRuns] = useState<{ id: string; label: string }[] | null>(null)
  const [runsAttempt, setRunsAttempt] = useState(0)
  const [runsFailed, setRunsFailed] = useState<string | null>(null)
  const award = drawer.award

  // Open pay runs resolve through the native payroll runs route with its
  // own scope — the drawer never reads run tables directly. Queuing names
  // the run; the route creates the native adjustment, so no adjustment id
  // is ever typed.
  useEffect(() => {
    if (!canQueue || award.status !== 'approved' || award.programDeliveryMethod === null || runs !== null) return
    let cancelled = false
    async function load() {
      setRunsFailed(null)
      try {
        const res = await fetch('/api/payroll/runs', { headers: { accept: 'application/json' } })
        if (!res.ok) {
          if (!cancelled) setRunsFailed(await readApiErrorMessage(res, t('portfolio.runsUnavailable')))
          return
        }
        const body: unknown = await res.json().catch(() => null)
        if (body === null || typeof body !== 'object' || !('runs' in body) || !Array.isArray(body.runs)) throw new Error(t('portfolio.runsUnavailable'))
        const list: unknown[] = body.runs
        const open = list
          .filter(
            (run): run is Record<string, unknown> =>
              typeof run === 'object' &&
              run !== null &&
              (run as { currency?: unknown }).currency === award.currency &&
              (run as { document_status?: unknown }).document_status === 'draft' &&
              (run as { run_status?: unknown }).run_status !== 'committed' &&
              (run as { run_status?: unknown }).run_status !== 'voided',
          )
          .map((run) => {
            const record = run as Record<string, string | null>
            const id = String(record.document_id ?? '')
            const parts = [record.document_number, record.schedule_name, record.period_end, record.pay_date].filter(
              (part): part is string => typeof part === 'string' && part !== '',
            )
            return { id, label: parts.length > 0 ? parts.join(' · ') : id }
          })
          .filter((run) => run.id !== '')
        if (!cancelled) setRuns(open)
      } catch {
        if (!cancelled) setRunsFailed(t('portfolio.runsUnavailable'))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [canQueue, award.status, award.currency, award.programDeliveryMethod, runs, runsAttempt, t])

  function close() {
    router.push(closeHref as never)
    router.refresh()
  }

  const closeGuard = useDirtyClose({
    dirty: externalRef.trim().length > 0 || queueing,
    busy: working,
    onClose: close,
    message: tCommon('feedback.unsavedChanges'),
    confirmLabel: tCommon('confirm.discardChanges'),
  })

  async function act(body: Record<string, unknown>) {
    setWorking(true)
    try {
      // Every award move patches the award resource; the id rides the path,
      // never the body.
      const res = await fetch(awardResourceUrl(award.id), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('portfolio.awardActionFailed')))
        return
      }
      setEnteringRef(false)
      setQueueing(false)
      router.refresh()
    } catch {
      toast.error(t('portfolio.awardActionFailed'))
    } finally {
      setWorking(false)
    }
  }

  async function voidAward() {
    const reason = await promptDialog({
      title: t('portfolio.voidReasonPrompt'),
      label: t('portfolio.voidReasonPrompt'),
      confirmLabel: t('portfolio.voidAward'),
    })
    if (reason === null) return
    if (reason.trim() === '') {
      toast.error(t('portfolio.voidReasonRequired'))
      return
    }
    await act({ action: 'void', reason: reason.trim() })
  }

  return (
    <Drawer open onClose={() => void closeGuard.close()} title={award.programName} description={award.valueLabel} size="md">
      <div className="flex flex-col gap-5 p-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">{t('portfolio.columns.program')}</dt>
            <dd className="font-medium text-slate-900 dark:text-slate-100">{award.programCode}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">{t('portfolio.columns.recipient')}</dt>
            <dd className="font-medium text-slate-900 dark:text-slate-100">{award.recipientLabel}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">{t('portfolio.columns.period')}</dt>
            <dd className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
              {award.periodTo ? `${award.periodFrom} – ${award.periodTo}` : award.periodFrom}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">{t('portfolio.columns.status')}</dt>
            <dd className="font-medium text-slate-900 dark:text-slate-100">{award.statusLabel}</dd>
          </div>
          {award.payRunDocumentId ? <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">{t('portfolio.queueRunLabel')}</dt>
            <dd><Link href={`/payroll/runs/${encodeURIComponent(award.payRunDocumentId)}` as never} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{t('portfolio.openPayRun')}</Link></dd>
          </div> : null}
          {award.externalRef ? (
            <div>
              <dt className="text-xs text-slate-500 dark:text-slate-400">{t('portfolio.columns.externalRef')}</dt>
              <dd className="font-medium text-slate-900 dark:text-slate-100">{award.externalRef}</dd>
            </div>
          ) : null}
          {award.voidReason ? (
            <div>
              <dt className="text-xs text-slate-500 dark:text-slate-400">{t('portfolio.columns.voidReason')}</dt>
              <dd className="font-medium text-slate-900 dark:text-slate-100">{award.voidReason}</dd>
            </div>
          ) : null}
        </dl>

        {award.status === 'approved' && award.decisionSnapshot?.mode === 'not_required' ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{t('portfolio.noApprovalSubmissionHint')}</p> : null}
        {award.status === 'approved' && award.decisionSnapshot?.mode === 'automatic' ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{t('portfolio.directProcessingHint')}</p> : null}
        {award.programDeliveryMethod === 'external' ? <p className="text-xs text-amber-800 dark:text-amber-200">{t('portfolio.builder.externalHint')}</p> : null}
        {canManage && award.status === 'draft' ? (
          <div className="flex justify-end">
            <Button disabled={working} onClick={() => act({ action: 'submit' })}>
              {t('portfolio.submitAward')}
            </Button>
          </div>
        ) : null}
        {award.status === 'pending' && award.approvalHref ? (
          <div className="flex justify-end">
            <Button asChild variant="outline"><Link href={award.approvalHref as never}>{t('portfolio.approvalControls.openApprovals')}</Link></Button>
          </div>
        ) : null}
        {canQueue && award.status === 'approved' && award.programDeliveryMethod !== null && !queueing ? (
          <div className="flex justify-end">
            <Button disabled={working} onClick={() => setQueueing(true)}>
              {t('portfolio.queueAward')}
            </Button>
          </div>
        ) : null}
        {canQueue && award.status === 'approved' && queueing ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${refId}-run`}>{t('portfolio.queueRunLabel')}</Label>
            {runs === null && !runsFailed ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{t('portfolio.queueRunsLoading')}</p>
            ) : null}
            {runsFailed ? (
              <div role="alert" className="text-xs text-red-700 dark:text-red-300">
                {runsFailed}
                <Button variant="outline" onClick={() => setRunsAttempt((attempt) => attempt + 1)}>{tCommon('actions.retry')}</Button>
              </div>
            ) : null}
            {runs !== null && runs.length === 0 && !runsFailed ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{t('portfolio.queueRunsEmpty')}</p>
            ) : null}
            {runs !== null && runs.length > 0 ? (
              <Select id={`${refId}-run`} value={runId} onChange={(e) => setRunId(e.target.value)}>
                <option value="">{t('portfolio.queueRunChoose')}</option>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.label}
                  </option>
                ))}
              </Select>
            ) : null}
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('portfolio.queueRunHint')}</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setQueueing(false)}>
                {t('portfolio.builder.cancel')}
              </Button>
              <Button
                disabled={working || !runId}
                onClick={() => act({ action: 'queue', payRunDocumentId: runId })}
              >
                {t('portfolio.queueAward')}
              </Button>
            </div>
          </div>
        ) : null}
        {canQueue && award.status === 'queued' && !enteringRef ? (
          <div className="flex flex-col gap-3">
            {award.programDeliveryMethod === 'payroll' && award.payRunDocumentId && award.payRunAdjustmentId ? (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('portfolio.linkedRunHint')}</p>
                <div className="flex justify-end">
                  <Button
                    disabled={working}
                    onClick={() =>
                      act({
                        action: 'payrollDelivery',
                        payRunDocumentId: award.payRunDocumentId,
                        payRunAdjustmentId: award.payRunAdjustmentId,
                      })
                    }
                  >
                    {t('portfolio.payrollDelivery')}
                  </Button>
                </div>
              </div>
            ) : !award.payRunDocumentId || !award.payRunAdjustmentId ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{t('portfolio.unlinkedQueueHint')}</p>
            ) : null}
            {award.programDeliveryMethod === 'external' ? <div className="flex justify-end">
              <Button variant="outline" onClick={() => setEnteringRef(true)}>
                {t('portfolio.externalDelivery')}
              </Button>
            </div> : null}
          </div>
        ) : null}
        {enteringRef ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor={refId}>{t('portfolio.externalRefLabel')}</Label>
            <Input
              id={refId}
              value={externalRef}
              onChange={(e) => setExternalRef(e.target.value)}
              placeholder={t('portfolio.externalRefPlaceholder')}
              required
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEnteringRef(false)}>
                {t('portfolio.builder.cancel')}
              </Button>
              <Button
                disabled={working || !externalRef.trim()}
                onClick={() => act({ action: 'externalDelivery', externalRef: externalRef.trim() })}
              >
                {t('portfolio.externalDelivery')}
              </Button>
            </div>
          </div>
        ) : null}
        {canManage && (award.status === 'draft' || award.status === 'pending' || award.status === 'approved' || (award.status === 'queued' && canQueue)) ? (
          <div className="flex justify-end">
            <Button variant="outline" disabled={working} onClick={voidAward}>
              {t('portfolio.voidAward')}
            </Button>
          </div>
        ) : null}
        {award.flowRunId ? <ApprovalHistory subjectKind="hrm_benefit_award" subjectId={award.id} showEmptyState /> : null}
        {award.status === 'delivered' || award.status === 'voided' ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">{drawer.timelineEmpty}</p>
        ) : null}
      </div>
    </Drawer>
  )
}
