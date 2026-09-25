'use client'

/** Split from RunWizard.tsx (ARCH-FILE-SPLIT; pure moves only). */
import { type Funding, type GlLeg } from '../run-wizard-model'
import { FundingPanel } from '../FundingPanel'
import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { AlertTriangle, CheckCircle2, Loader2, Send } from 'lucide-react'
import { Badge, Button, TableCell, TableRow } from '@openbooks/ui'
import type { PayRunCalculationError, PayRunRefusalAcknowledgement } from '@openbooks/engine/src/payroll/run-calculation-evidence.ts'
import type { PayRunApprovalState } from '@openbooks/engine/src/payroll/approval.ts'
import { ApprovalActions } from '../../../../../../components/approval-actions'
import { ApprovalHistory } from '../../../../../../components/approval-history'
import { FlowManualButtons } from '../../../../../../components/flow-manual-buttons'
import { PagedTable, type PagedColumn } from '../../../../../../components/paged-table'
import { decimalAbs, decimalCmp, decimalNeg, decimalSum } from '../../../../../../lib/statement-format'

/* ------------------------------------------------------------------ */
/* Step 3 — GL preview & commit                                        */
/* ------------------------------------------------------------------ */

export function GlStep({
  gl,
  documentId,
  calculated,
  committed,
  canCommit,
  canSubmitApproval,
  approval,
  canAcknowledge,
  stale,
  funding,
  busy,
  refusals,
  acknowledgement,
  refusalsAcked,
  anomalyBlocks,
  onAcknowledge,
  onRetry,
  onCommit,
  onSubmitApproval,
  fmt,
}: {
  gl: { state: 'idle' | 'loading' | 'ready' | 'setup-error'; legs: GlLeg[]; debitTotal: string; error: string }
  documentId: string
  calculated: boolean
  committed: boolean
  canCommit: boolean
  /** A pay-run approval policy covers the org and this run is unsubmitted. */
  canSubmitApproval: boolean
  /** Native Flows approval state, resolved server-side by the loader. */
  approval: PayRunApprovalState
  canAcknowledge: boolean
  stale: boolean
  funding: Funding
  busy: boolean
  refusals: PayRunCalculationError[]
  acknowledgement: PayRunRefusalAcknowledgement | null
  refusalsAcked: boolean
  /** HR-21: open block-severity anomaly flags — commit stays off. */
  anomalyBlocks: number
  onAcknowledge: () => void
  onRetry: () => void
  onCommit: () => void
  onSubmitApproval: () => void
  fmt: (v: string | number | null | undefined) => string
}) {
  const t = useTranslations('payroll')
  const [ackChecked, setAckChecked] = useState(false)

  if (!calculated) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        {t('wizard.gl.needsCalculation')}
      </div>
    )
  }

  if (gl.state === 'setup-error') {
    return (
      <div className="rounded-xl border border-amber-200/80 bg-amber-50 px-4 py-4 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
        <p className="mb-1 flex items-center gap-2 font-semibold">
          <AlertTriangle size={15} aria-hidden />
          {t('wizard.gl.setupIncomplete')}
        </p>
        <p className="mb-3">{gl.error}</p>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href={'/admin/setup/payroll?tab=accounts' as never}>{t('wizard.gl.openSetup')}</Link>
          </Button>
          <Button size="sm" variant="ghost" onClick={onRetry}>
            {t('wizard.gl.retry')}
          </Button>
        </div>
      </div>
    )
  }

  if (gl.state !== 'ready') {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-10 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        <Loader2 size={15} className="animate-spin" aria-hidden />
        {t('wizard.gl.loading')}
      </div>
    )
  }

  const debits = gl.legs.filter((leg) => decimalCmp(leg.amount, '0') > 0)
  const credits = gl.legs.filter((leg) => decimalCmp(leg.amount, '0') < 0)
  const creditTotal = decimalNeg(decimalSum(credits.map((leg) => leg.amount)))

  return (
    <div className="space-y-4">
      {/* Refused employees are named HERE, at commit — not only in the review
          step's exception list. The commit button stays off until the operator
          acknowledges exactly this set, with the refusal text in front of
          them; the acknowledgement is recorded on the run for audit. */}
      {refusals.length > 0 && !committed && (
        <div className="rounded-xl border border-red-200/80 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-300">
          <p className="mb-1 flex items-center gap-2 font-semibold">
            <AlertTriangle size={15} aria-hidden />
            {t('wizard.gl.refusedTitle', { count: refusals.length })}
          </p>
          <p className="mb-2">{t('wizard.gl.refusedHint')}</p>
          <ul className="ml-6 list-disc space-y-0.5">
            {refusals.map((entry) => (
              <li key={entry.employeePartyId}>
                <span className="font-medium">{entry.employee}</span>: {entry.message}
              </li>
            ))}
          </ul>
          {refusalsAcked && acknowledgement ? (
            <p className="mt-2 text-xs">
              {t('wizard.gl.ackRecordedNote', {
                count: acknowledgement.refusals.length,
                date: acknowledgement.acknowledgedAt.slice(0, 10),
              })}
            </p>
          ) : canAcknowledge ? (
            <div className="mt-3 space-y-2">
              <label className="flex cursor-pointer items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-red-600"
                  checked={ackChecked}
                  onChange={(e) => setAckChecked(e.target.checked)}
                />
                <span>{t('wizard.gl.ackLabel', { count: refusals.length })}</span>
              </label>
              <Button size="sm" variant="outline" disabled={busy || !ackChecked} onClick={onAcknowledge}>
                {t('wizard.gl.ackRecord', { count: refusals.length })}
              </Button>
            </div>
          ) : null}
        </div>
      )}
      {/* Submitted and awaiting a decision: no submit again, and the shared
          Flows surfaces own the rest — approve/reject for deciders (or a
          pending-with chip), author-defined record buttons, and the decision
          history. Each renders nothing when it has nothing to say, so no
          policy means no banner, exactly like the expenses drawer. No
          submitApprovalHref: that shared path posts an empty body and the
          payroll boundary requires the named submit-approval action (with
          evidence assembly) — it would 400, so the wizard's own Submit
          button below is the only submit path. The engine exposes no
          submitter recall for pay runs, so none is wired. */}
      {approval.policyExists && approval.pending && !committed && (
        <div className="rounded-xl border border-blue-200/80 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-800/60 dark:bg-blue-950/40 dark:text-blue-300">
          <p className="mb-2 font-semibold">{t('run.approvalPending', { count: approval.outstandingGates })}</p>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <FlowManualButtons subjectKind="pay_run" subjectId={documentId} />
            <ApprovalActions subjectKind="pay_run" subjectId={documentId} />
          </div>
          <ApprovalHistory subjectKind="pay_run" subjectId={documentId} />
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('wizard.gl.hint')}</p>
        {/* The commit refusal names submit-for-approval as its remedy, so the
            remedy stands where the refusal fires: while the run is
            unsubmitted in a policy org the submit button takes commit's
            place (commit would only 422 with the not-submitted refusal).
            No policy, no button — commit behaves exactly as before. */}
        {canSubmitApproval ? (
          <Button onClick={onSubmitApproval} disabled={busy} variant="outline">
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} aria-hidden />}
            {t('run.submitApproval')}
          </Button>
        ) : canCommit ? (
          <Button onClick={onCommit} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <CheckCircle2 size={14} aria-hidden />}
            {t('run.commit')}
          </Button>
        ) : stale && !committed ? (
          <span className="text-sm text-amber-600 dark:text-amber-400">{t('wizard.gl.staleBlocked')}</span>
        ) : refusals.length > 0 && !refusalsAcked && !committed ? (
          <span className="text-sm text-red-600 dark:text-red-400">{t('wizard.gl.refusedBlocked', { count: refusals.length })}</span>
        ) : anomalyBlocks > 0 && !committed ? (
          <span className="text-sm text-red-600 dark:text-red-400">
            {t('anomalies.wizardNotice', { count: anomalyBlocks })}{' '}
            <a href="/payroll/anomalies" className="font-medium underline">
              {t('anomalies.wizardLink')}
            </a>
          </span>
        ) : null}
        {committed && (
          <Badge variant="default">{t('status.committed')}</Badge>
        )}
      </div>

      <FundingPanel funding={funding} fmt={fmt} />

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
<div className="p-3">
          <PagedTable
            rows={[...debits, ...credits]}
            columns={([
              {
                key: 'account', header: t('wizard.gl.account'),
                search: (leg) => `${leg.accountLabel} ${leg.partyName ?? ''} ${leg.projectName ?? ''}`,
                cell: (leg) => (
                  <span>
                    {leg.accountLabel}
                    {leg.partyName ? <span className="ml-1.5 text-xs text-slate-400">{leg.partyName}</span> : null}
                    {leg.projectName ? <span className="ml-1.5 text-xs text-slate-400">{leg.projectName}</span> : null}
                  </span>
                ),
              },
              { key: 'description', header: t('wizard.gl.description'), cell: (leg) => leg.description },
              {
                key: 'debit', header: t('wizard.gl.debits'), align: 'right',
                cell: (leg) => (decimalCmp(leg.amount, '0') > 0 ? fmt(leg.amount) : ''),
              },
              {
                key: 'credit', header: t('wizard.gl.credits'), align: 'right',
                cell: (leg) => (decimalCmp(leg.amount, '0') < 0 ? fmt(decimalAbs(leg.amount)) : ''),
              },
            ] as PagedColumn<GlLeg>[])}
            pageSize={25}
            searchable
            empty={<p className="p-2 text-sm text-slate-500 dark:text-slate-400">{t('wizard.gl.hint')}</p>}
            rowKey={(leg, index) => `${leg.accountId}-${index}`}
            footer={
              <TableRow className="border-t-2 border-slate-200 bg-slate-50 font-semibold dark:border-slate-700 dark:bg-slate-950/40">
                <TableCell colSpan={2}>{t('wizard.gl.balanced')}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(gl.debitTotal)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(creditTotal)}</TableCell>
              </TableRow>
            }
          />
        </div>
      </div>

      {canCommit && (
        <p className="text-xs text-slate-400 dark:text-slate-500">{t('wizard.gl.commitHint')}</p>
      )}
    </div>
  )
}
