'use client'

/** Split from RunWizard.tsx (ARCH-FILE-SPLIT; pure moves only). */
import { type Funding, type RunHeader, type RemittanceRow } from '../run-wizard-model'
import { FundingPanel } from '../FundingPanel'
import { AttributeEntityControl, RecordPaymentControl } from '../run-wizard-controls'
import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertTriangle, ArrowRight, BookOpenCheck, CheckCircle2, FileDown, Loader2, Send } from 'lucide-react'
import { Badge, Button, TableCell, TableRow, cn } from '@openbooks/ui'
import type { YearEndFilingSection } from '@openbooks/engine/src/payroll/yearend.ts'
import type { PayRunRefusalAcknowledgement } from '@openbooks/engine/src/payroll/run-calculation-evidence.ts'
import { readApiErrorMessage } from '../../../../../../lib/api-error'
import { PagedTable, type PagedColumn } from '../../../../../../components/paged-table'
import { SeparationIssuePanel } from '../../../_ui/filing-workspace'
import { BankFilePanel } from '../BankFilePanel'
import { decimalAbs } from '../../../../../../lib/statement-format'

/* ------------------------------------------------------------------ */
/* Step 5 — Post & finish                                              */
/* ------------------------------------------------------------------ */

/**
 * Print the run's cheque batch.
 *
 * POST, not a link: the first print ALLOCATES cheque numbers off the org's
 * number sequence, and stock must not be consumed by a browser prefetch. The
 * response is a PDF, so the blob is opened in a new tab exactly as the stub
 * link does — reprinting is safe and returns the same numbers.
 */
export async function fetchChequePdf(documentId: string, fallback: string): Promise<Blob> {
  const res = await fetch(`/api/payroll/runs/${documentId}/cheques-pdf`, { method: 'POST' })
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback))
  return res.blob()
}

function PrintChequesButton({ documentId, count }: { documentId: string; count: number }) {
  const t = useTranslations('payroll')
  const [busy, setBusy] = useState(false)
  async function print() {
    setBusy(true)
    // Reserve the print surface synchronously inside the click: a tab opened
    // after the POST awaits loses transient activation and is blocked
    // silently, after the server already allocated the cheque numbers.
    const tab = window.open('about:blank', '_blank')
    try {
      const url = URL.createObjectURL(await fetchChequePdf(documentId, t('wizard.finish.chequesFailed')))
      if (tab && !tab.closed) {
        tab.location.href = url
        tab.opener = null
      } else {
        // Popup blocked: fall back to an in-page download, which blockers
        // allow, and say so — the numbers are allocated either way.
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `cheques-${documentId}.pdf`
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        toast.warning(t('wizard.finish.chequesPopupBlocked'))
      }
      // Revoked late so the new tab has finished reading the blob.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (e) {
      // Never strand the reserved blank tab on a failed POST.
      tab?.close()
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void print()}>
      {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <FileDown size={14} aria-hidden />}
      {t('wizard.finish.printCheques', { count })}
    </Button>
  )
}

export function FinishStep({
  run,
  separationSections,
  remittance,
  posted,
  committed,
  canPost,
  busy,
  onPost,
  onEmailStubs,
  onRecordPayment,
  onAttributeEntity,
  registerReportId,
  bankAccounts,
  entityOptions,
  canAttributeEntity,
  funding,
  canRun,
  acknowledgement,
  fmt,
}: {
  run: RunHeader
  separationSections: YearEndFilingSection[]
  remittance: RemittanceRow[]
  posted: boolean
  committed: boolean
  canPost: boolean
  busy: boolean
  onPost: () => void
  onEmailStubs: () => void
  onRecordPayment: (bankAccountId: string) => void
  onAttributeEntity: (subsidiaryId: string) => void
  registerReportId: string | null
  bankAccounts: { id: string; label: string }[]
  entityOptions: { id: string; label: string }[]
  canAttributeEntity: boolean
  funding: Funding
  canRun: boolean
  acknowledgement: PayRunRefusalAcknowledgement | null
  fmt: (v: string | number | null | undefined) => string
}) {
  const t = useTranslations('payroll')
  const chequeCount = funding.rails.find((rail) => rail.method === 'cheque')?.employees ?? 0
  if (!committed && !posted) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        {t('wizard.finish.notCommitted')}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3.5',
          posted
            ? 'border-emerald-200/80 bg-emerald-50 dark:border-emerald-800/60 dark:bg-emerald-950/40'
            : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
        )}
      >
        <div className="flex items-center gap-3">
          {posted ? (
            <CheckCircle2 size={20} className="text-emerald-600 dark:text-emerald-400" aria-hidden />
          ) : (
            <Send size={18} className="text-slate-400" aria-hidden />
          )}
          <div>
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {posted ? t('wizard.finish.postedTitle') : t('wizard.finish.postTitle')}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {posted
                ? t('wizard.finish.postedHint', { number: run.document_number })
                : t('wizard.finish.postHint')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {posted && run.posted_entry_id && (
            <Button asChild size="sm" variant="outline">
              <Link href={`/journal?txn=${run.posted_entry_id}` as never}>
                <BookOpenCheck size={14} aria-hidden />
                {t('wizard.finish.viewJournal')}
              </Link>
            </Button>
          )}
          {posted && run.paid_at && (
            <Badge variant="success">{t('wizard.finish.paid')}</Badge>
          )}
          {posted && run.paid_entry_id && (
            <Button asChild size="sm" variant="ghost">
              <Link href={`/journal?txn=${run.paid_entry_id}` as never}>
                {t('wizard.finish.viewPayment')}
              </Link>
            </Button>
          )}
          {posted && !run.paid_at && canRun && (
            <RecordPaymentControl
              bankAccounts={bankAccounts}
              busy={busy}
              onRecord={onRecordPayment}
            />
          )}
          {committed && (
            <>
              <Button asChild size="sm" variant="outline">
                <a href={`/api/payroll/runs/${run.document_id}/stubs-pdf`} target="_blank" rel="noreferrer">
                  <FileDown size={14} aria-hidden />
                  {t('wizard.finish.printStubs')}
                </a>
              </Button>
              {canRun && chequeCount > 0 && (
                <PrintChequesButton documentId={run.document_id} count={chequeCount} />
              )}
              {registerReportId && (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/reports/custom/run/${registerReportId}` as never}>
                    {t('wizard.finish.register')}
                  </Link>
                </Button>
              )}
              {canRun && (
                <Button size="sm" variant="outline" disabled={busy} onClick={onEmailStubs}>
                  <Send size={14} aria-hidden />
                  {t('wizard.finish.emailStubs')}
                </Button>
              )}
              {/* Legacy entityless run: attributing it here is the remedy the
                  remittance refusal names. Offered only while the header
                  carries no entity and only to callers the route serves
                  (scoped roles get a 404 there); a refresh after
                  attributing removes it. */}
              {canRun && canAttributeEntity && run.subsidiary_id == null && entityOptions.length > 0 && (
                <AttributeEntityControl
                  entityOptions={entityOptions}
                  busy={busy}
                  onAttribute={onAttributeEntity}
                />
              )}
            </>
          )}
          {!posted && canPost && (
            <Button onClick={onPost} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} aria-hidden />}
              {t('run.post')}
            </Button>
          )}
        </div>
      </div>

      {/* A partial run committed deliberately: who was left out and why stays
          visible after posting, with the honest recovery — answer the missing
          input once its surface ships, then pay the missing employees on an
          off-cycle run. A posted run is never edited in place. */}
      {acknowledgement && acknowledgement.refusals.length > 0 && (
        <div className="rounded-xl border border-amber-200/80 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
          <p className="mb-1 flex items-center gap-2 font-semibold">
            <AlertTriangle size={15} aria-hidden />
            {t('wizard.finish.partialTitle', { count: acknowledgement.refusals.length })}
          </p>
          <ul className="ml-6 list-disc space-y-0.5">
            {acknowledgement.refusals.map((entry) => (
              <li key={entry.employeePartyId}>
                <span className="font-medium">{entry.employee}</span>: {entry.message}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            {t('wizard.finish.partialRecorded', { date: acknowledgement.acknowledgedAt.slice(0, 10) })}
          </p>
          <p className="mt-1 text-xs">{t('wizard.finish.partialRecovery')}</p>
        </div>
      )}

      {!run.paid_at && <FundingPanel funding={funding} fmt={fmt} />}

      {/* Direct deposit sits directly under Funding on purpose: the cash the
          controller has to have in the account and the instruction that draws
          it are one decision, and reading them apart is how a payday goes out
          twice. Committed runs only — there is nothing to instruct off figures
          that can still change. */}
      {committed && (
        <BankFilePanel documentId={run.document_id} canRun={canRun} fmt={fmt} />
      )}

      {/* Termination runs: the pack-declared SEPARATION filings (the ROE) are
          due within days of the interruption of earnings, so they are issued
          HERE, on the run that pays the employee out — never parked on the
          year-end page. Same drawer, facsimile and reason flow as the
          Separations surface. */}
      {committed && separationSections.length > 0 && (
        <SeparationIssuePanel sections={separationSections} year={run.tax_year} canFile={canRun} />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {t('wizard.finish.remittanceTitle')}
            </h3>
            <p className="text-xs text-slate-400 dark:text-slate-500">{t('wizard.finish.remittanceHint')}</p>
          </div>
<div className="p-3">
            <PagedTable
              rows={remittance}
              columns={([
                {
                  key: 'account', header: t('wizard.gl.account'),
                  search: (row) => row.account_label,
                  cell: (row) => <span className="font-medium">{row.account_label}</span>,
                },
                {
                  key: 'amount', header: t('wizard.finish.amount'), align: 'right',
                  cell: (row) => fmt(decimalAbs(row.amount)),
                },
              ] as PagedColumn<RemittanceRow>[])}
              pageSize={15}
              empty={<p className="p-2 text-sm text-slate-500 dark:text-slate-400">{t('wizard.finish.remittanceHint')}</p>}
              rowKey={(row, index) => `${row.account_label}-${index}`}
              footer={
                <TableRow className="border-t-2 border-slate-200 bg-slate-50 font-semibold dark:border-slate-700 dark:bg-slate-950/40">
                  <TableCell>{t('wizard.finish.netPay')}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(run.net_total)}</TableCell>
                </TableRow>
              }
            />
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h3 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
            {t('wizard.finish.nextTitle')}
          </h3>
          <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
            <li className="flex items-start gap-2">
              <ArrowRight size={14} aria-hidden className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" />
              {t('wizard.finish.nextRemit')}
            </li>
            <li className="flex items-start gap-2">
              <ArrowRight size={14} aria-hidden className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" />
              {t('wizard.finish.nextPay')}
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}
