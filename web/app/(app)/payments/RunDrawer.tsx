'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Check, Download, FileCheck2, RotateCcw, Send, X } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle, Badge, Button, Drawer, Input, Label, Select, Textarea, UrlDrawer } from '@openbooks/ui'
import { confirmDialog } from '../../../lib/confirm'
import { money } from '../../../lib/format'

/**
 * Payment-run flyout: instructions, EFT readiness, and the two explicit
 * actions — CPA-005 file download (draft → exported) and posting the run's
 * payments + applications (exported → confirmed).
 */

const RUN_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline' | 'default'> = {
  confirmed: 'success',
  generated: 'default',
  delivered: 'default',
  settled: 'success',
  returned: 'warning',
  partially_failed: 'warning',
  rejected: 'outline',
  rolled_back: 'outline',
  approved: 'default',
  pending_approval: 'warning',
  draft: 'secondary',
  cancelled: 'outline',
}

const INSTRUCTION_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline' | 'destructive'> = {
  sent: 'success',
  settled: 'success',
  pending: 'secondary',
  returned: 'destructive',
  cancelled: 'outline',
}

// payment_instructions.status enum values with a translated display label.
const INSTRUCTION_STATUS_KEYS = ['pending', 'approved', 'generated', 'sent', 'settled', 'returned', 'rejected', 'failed', 'reversed', 'cancelled']

// payment_runs.status enum → common.status.* message keys (confirmed/exported
// live in payments.runs.status.*; fallback: raw value).
const RUN_STATUS_COMMON_KEY: Record<string, string> = {
  draft: 'draft',
  pending_approval: 'pendingApproval',
  approved: 'approved',
  cancelled: 'cancelled',
}

export interface RunBlockerClient {
  instructionId: string
  payee: string
  reason: string
}

export function RunDrawer({
  run,
  instructions,
  eftConfigured,
  eftMissing,
  blockers,
  files,
  events,
  items,
  canApprove,
}: {
  run: Record<string, any>
  instructions: Record<string, any>[]
  eftConfigured: boolean
  eftMissing: string[]
  blockers: RunBlockerClient[]
  files: Record<string, any>[]
  events: Record<string, any>[]
  items: Record<string, any>[]
  canApprove: boolean
}) {
  const t = useTranslations('payments')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [deliverOpen, setDeliverOpen] = useState(false)
  const [sftpServers, setSftpServers] = useState<{ id: string; name: string }[]>([])
  const [sftpServerId, setSftpServerId] = useState('')
  const [instructionQ, setInstructionQ] = useState('')
  const [instructionPage, setInstructionPage] = useState(1)
  const [decision, setDecision] = useState<{ kind: 'rejectRun' | 'rejectFile' | 'rollback'; fileId?: string } | null>(null)
  const [reason, setReason] = useState('')
  const closeHref = '/payments?view=runs'

  async function openDeliver() {
    setDeliverOpen(true)
    const res = await fetch(`/api/payments/runs/${run.id}/deliver`)
    const data = await res.json()
    if (res.ok) {
      setSftpServers(data.servers ?? [])
      setSftpServerId(data.servers?.[0]?.id ?? '')
    }
  }

  async function deliver() {
    if (!sftpServerId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/payments/runs/${run.id}/deliver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sftpServerId }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? t('runDrawer.toasts.deliverFailed')); return }
      toast.success(t('runDrawer.toasts.delivered', { path: data.path }))
      setDeliverOpen(false)
      router.refresh()
    } finally { setBusy(false) }
  }
  const runStatusLabel = (status: string) => {
    if (['confirmed', 'generated', 'delivered', 'settled', 'returned', 'partially_failed', 'rejected', 'rolled_back'].includes(status)) return t(`runs.status.${status}`)
    const key = RUN_STATUS_COMMON_KEY[status]
    return key ? tCommon(`status.${key}`) : status.replace('_', ' ')
  }
  const blockerByInstruction = new Map(blockers.map((b) => [b.instructionId, b.reason]))
  const live = instructions.filter((i) => i.status !== 'cancelled')
  const filteredInstructions = instructions.filter((i) => !instructionQ || String(i.payee).toLowerCase().includes(instructionQ.toLowerCase()) || String(i.document_number ?? '').toLowerCase().includes(instructionQ.toLowerCase()))
  const instructionPages = Math.max(1, Math.ceil(filteredInstructions.length / 10))
  const shownInstructions = filteredInstructions.slice((instructionPage - 1) * 10, instructionPage * 10)
  const total = live.reduce((acc, i) => acc + Number(i.amount), 0)
  const latestFile = files[0]
  const hasApprovedFile = latestFile && (latestFile.status === 'approved' || latestFile.status === 'delivered')
  const canGenerate = eftConfigured && blockers.length === 0 && run.status === 'approved'
  const canPost = hasApprovedFile && ['generated', 'delivered', 'partially_failed'].includes(run.status)
  const canCancel = run.status === 'draft'

  async function action(path: string, body?: Record<string, unknown>, success?: string) {
    setBusy(true)
    try {
      const res = await fetch(`/api/payments/runs/${run.id}/${path}`, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(data.error ?? t('runDrawer.toasts.actionFailed')); return false }
      if (success) toast.success(success)
      router.refresh()
      return true
    } finally { setBusy(false) }
  }

  async function generateFile() {
    const ok = await action('file', undefined, t('runDrawer.toasts.fileGenerated'))
    if (ok) router.refresh()
  }

  async function decideRun(decisionValue: 'approve' | 'reject', rejectionReason?: string) {
    const ok = await action('decision', { decision: decisionValue, reason: rejectionReason }, t(`runDrawer.toasts.run${decisionValue === 'approve' ? 'Approved' : 'Rejected'}`))
    if (ok) { setDecision(null); setReason('') }
  }

  async function decideFile(fileId: string, decisionValue: 'approve' | 'reject', rejectionReason?: string) {
    const ok = await action(`files/${fileId}/decision`, { decision: decisionValue, reason: rejectionReason }, t(`runDrawer.toasts.file${decisionValue === 'approve' ? 'Approved' : 'Rejected'}`))
    if (ok) { setDecision(null); setReason('') }
  }

  async function postRun() {
    const ok = await confirmDialog({
      message: t('runDrawer.confirmPost', {
        count: live.filter((i) => i.status === 'pending').length,
        total: money(total),
      }),
    })
    if (!ok) return
    setBusy(true)
    const res = await fetch(`/api/payments/runs/${run.id}/post`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('runDrawer.toasts.postFailed'))
    } else if (data.failures?.length) {
      toast.error(
        t('runDrawer.toasts.postedWithFailures', {
          count: data.posted,
          failures: data.failures.map((f: any) => `${f.payee} (${f.error})`).join('; '),
        }),
      )
    } else {
      toast.success(t('runDrawer.toasts.posted', { count: data.posted }))
    }
    setBusy(false)
    router.refresh()
  }

  async function cancelRun() {
    const ok = await confirmDialog({
      message: t('runDrawer.confirmCancel', { number: run.run_number }),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    const res = await fetch(`/api/payments/runs/${run.id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? t('runDrawer.toasts.cancelFailed'))
    else toast.success(t('runDrawer.toasts.cancelled'))
    setBusy(false)
    router.refresh()
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono">{run.run_number}</span>
          <Badge variant={RUN_VARIANT[run.status] ?? 'secondary'}>{runStatusLabel(String(run.status))}</Badge>
        </span>
      }
      description={
        run.scheduled_for
          ? t('runDrawer.descriptionEftWithDate', {
              bank: `${run.bank_number ?? ''} ${run.bank_name ?? ''}`.trim() || t('runDrawer.bankAccountFallback'),
              date: run.scheduled_for,
            })
          : t('runDrawer.descriptionEft', {
              bank: `${run.bank_number ?? ''} ${run.bank_name ?? ''}`.trim() || t('runDrawer.bankAccountFallback'),
            })
      }
      headerActions={
        <>
          {canCancel ? (
            <Button variant="outline" disabled={busy} onClick={cancelRun}>
              {t('runDrawer.cancelRun')}
            </Button>
          ) : null}
          {run.status === 'draft' ? <Button disabled={busy} onClick={() => action('submit', undefined, t('runDrawer.toasts.submitted'))}>{t('runDrawer.submitRun')}</Button> : null}
          {run.status === 'pending_approval' && canApprove ? <><Button variant="outline" disabled={busy} onClick={() => { setReason(''); setDecision({ kind: 'rejectRun' }) }}><X size={15} />{t('runDrawer.reject')}</Button><Button disabled={busy} onClick={() => decideRun('approve')}><Check size={15} />{t('runDrawer.approve')}</Button></> : null}
          {canGenerate ? <Button disabled={busy} onClick={generateFile}><FileCheck2 size={15} />{t('runDrawer.generateFile')}</Button> : null}
          {hasApprovedFile ? <>
            <Button variant="outline" asChild><a href={`/api/payments/runs/${run.id}/file`} download onClick={() => setTimeout(() => router.refresh(), 800)}><Download size={15} />{t('runDrawer.downloadFile')}</a></Button>
            <Button variant="outline" disabled={busy} onClick={openDeliver}><Send size={15} />{t('runDrawer.deliverSftp')}</Button>
          </> : null}
          {latestFile?.status === 'pending_approval' && canApprove ? <><Button variant="outline" disabled={busy} onClick={() => { setReason(''); setDecision({ kind: 'rejectFile', fileId: latestFile.id }) }}><X size={15} />{t('runDrawer.rejectFile')}</Button><Button disabled={busy} onClick={() => decideFile(latestFile.id, 'approve')}><Check size={15} />{t('runDrawer.approveFile')}</Button></> : null}
          {latestFile && ['rejected', 'delivered', 'approved'].includes(latestFile.status) && ['generated', 'delivered', 'partially_failed'].includes(run.status) ? <Button variant="outline" disabled={busy} onClick={() => action(`files/${latestFile.id}/reprocess`, undefined, t('runDrawer.toasts.fileReprocessed'))}><RotateCcw size={15} />{t('runDrawer.reprocess')}</Button> : null}
          {['approved', 'generated', 'delivered', 'partially_failed'].includes(run.status) && !live.some((i) => ['sent', 'settled', 'returned'].includes(i.status)) ? <Button variant="outline" disabled={busy} onClick={() => { setReason(''); setDecision({ kind: 'rollback' }) }}>{t('runDrawer.rollback')}</Button> : null}
          {canPost ? (
            <Button disabled={busy} onClick={postRun}>
              {busy ? tCommon('actions.posting') : t('runDrawer.postPayments')}
            </Button>
          ) : null}
        </>
      }
      footer={
        <div className="flex w-full flex-wrap items-center gap-3">
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            {t.rich('runDrawer.paymentsSummary', {
              count: live.length,
              amount: money(total),
              total: (chunks) => <strong className="text-slate-900 dark:text-slate-100">{chunks}</strong>,
            })}
          </span>
        </div>
      }
    >
      <div className="space-y-4 p-1">
        {!eftConfigured ? (
          <Alert variant="warning">
            <AlertTitle>{t('configuration.runNotReadyTitle')}</AlertTitle>
            <AlertDescription>
              {t('configuration.runNotReadyDescription', { missing: eftMissing.join(', ') })}
            </AlertDescription>
          </Alert>
        ) : null}
        {blockers.length > 0 && run.status !== 'cancelled' && run.status !== 'confirmed' ? (
          <Alert variant="destructive">
            <AlertTitle>{t('runDrawer.payeesMissingBankDetails')}</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-5">
                {blockers.map((b) => (
                  <li key={b.instructionId}>
                    {b.payee} — {b.reason}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {files.length ? <section className="space-y-2"><h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('runDrawer.filesTitle')}</h3><div className="grid gap-2">{files.map((file) => <div key={file.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800"><div><p className="text-sm font-medium">{file.filename}</p><p className="font-mono text-[11px] text-slate-500">{String(file.content_hash).slice(0, 16)}… · v{file.sequence_number}</p></div><div className="flex items-center gap-2"><span className="text-xs tabular-nums text-slate-500">{file.payment_count} · {money(file.total_amount)} {file.currency}</span><Badge variant={file.status === 'approved' || file.status === 'delivered' ? 'success' : file.status === 'rejected' ? 'destructive' : 'secondary'}>{t(`runDrawer.fileStatus.${file.status}`)}</Badge></div></div>)}</div></section> : null}

        {items.length ? <section className="space-y-2"><h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('runDrawer.sourcesTitle')}</h3><div className="grid gap-2 sm:grid-cols-2">{items.map((item) => <div key={item.id} className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800"><div className="flex justify-between gap-3"><span className="font-mono text-xs font-semibold">{item.document_number}</span><span className="tabular-nums">{money(item.payment_amount)} {item.currency}</span></div><p className="mt-1 text-xs text-slate-500">{item.party_name}</p>{Number(item.discount_amount) || Number(item.credit_amount) ? <p className="mt-1 text-xs text-slate-500">{t('runDrawer.adjustments', { discount: money(item.discount_amount), credit: money(item.credit_amount) })}</p> : null}</div>)}</div></section> : null}

        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('runDrawer.instructionsTitle')}</h3><Input value={instructionQ} onChange={(e) => { setInstructionQ(e.target.value); setInstructionPage(1) }} placeholder={t('runDrawer.searchInstructions')} className="max-w-64" /></div>
        <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <th className="px-3 py-2">{t('runDrawer.columns.payee')}</th>
                <th className="px-3 py-2">{t('runDrawer.columns.payment')}</th>
                <th className="px-3 py-2">{t('runDrawer.columns.bankDetails')}</th>
                <th className="px-3 py-2">{tCommon('labels.status')}</th>
                <th className="px-3 py-2 text-right">{tCommon('labels.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {shownInstructions.map((i) => (
                <tr key={i.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                  <td className="px-3 py-2">{i.payee}</td>
                  <td className="px-3 py-2 font-mono text-[13px] font-semibold">
                    {i.payment_document_id ? (
                      <Link
                        href={`/payments?payment=${i.payment_document_id}` as any}
                        className="text-teal-700 hover:underline dark:text-teal-300"
                      >
                        {i.document_number}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {i.status === 'cancelled' ? (
                      <span className="text-slate-400">—</span>
                    ) : blockerByInstruction.has(i.id) ? (
                      <Badge variant="warning">{blockerByInstruction.get(i.id)}</Badge>
                    ) : (
                      <Badge variant="success">{t('runDrawer.bankApproved')}</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={INSTRUCTION_VARIANT[i.status] ?? 'secondary'}>
                      {INSTRUCTION_STATUS_KEYS.includes(i.status)
                        ? t(`runDrawer.instructionStatus.${i.status}`)
                        : i.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(i.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {instructionPages > 1 ? <div className="flex items-center justify-end gap-2"><Button size="sm" variant="outline" disabled={instructionPage <= 1} onClick={() => setInstructionPage((p) => p - 1)}>{tCommon('actions.previous')}</Button><span className="text-xs text-slate-500">{instructionPage} / {instructionPages}</span><Button size="sm" variant="outline" disabled={instructionPage >= instructionPages} onClick={() => setInstructionPage((p) => p + 1)}>{tCommon('actions.next')}</Button></div> : null}

        {events.length ? <section className="space-y-2"><h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('runDrawer.activityTitle')}</h3><div className="space-y-2">{events.slice(0, 10).map((event) => <div key={event.id} className="flex items-start justify-between gap-3 border-l-2 border-slate-200 pl-3 text-sm dark:border-slate-700"><div><p>{t(`runDrawer.events.${event.event_type}` as any)}</p><p className="text-xs text-slate-500">{event.actor_name ?? t('runDrawer.systemActor')}</p></div><time className="shrink-0 text-xs text-slate-500">{new Date(event.created_at).toLocaleString()}</time></div>)}</div></section> : null}
      </div>

      <Drawer
        open={deliverOpen}
        onClose={() => setDeliverOpen(false)}
        size="sm"
        title={t('runDrawer.deliverSftp')}
        description={t('runDrawer.deliverHint')}
        headerActions={
          <>
            <Button variant="outline" onClick={() => setDeliverOpen(false)}>{tCommon('actions.cancel')}</Button>
            <Button disabled={busy || !sftpServerId} onClick={deliver}>
              {busy ? tCommon('actions.sending') : t('runDrawer.deliverSftp')}
            </Button>
          </>
        }
      >
        <div className="space-y-1.5 p-1">
          <Label>{t('runDrawer.sftpServer')}</Label>
          {sftpServers.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-300 px-3 py-4 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
              {t('runDrawer.noSftpServers')}
            </p>
          ) : (
            <Select value={sftpServerId} onChange={(e) => setSftpServerId(e.target.value)}>
              {sftpServers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          )}
        </div>
      </Drawer>
      <Drawer open={decision !== null} onClose={() => setDecision(null)} size="sm" title={decision?.kind === 'rollback' ? t('runDrawer.rollback') : decision?.kind === 'rejectFile' ? t('runDrawer.rejectFile') : t('runDrawer.reject')} description={t('runDrawer.reasonRequired')} headerActions={<><Button variant="outline" onClick={() => setDecision(null)}>{tCommon('actions.cancel')}</Button><Button variant="destructive" disabled={busy || !reason.trim()} onClick={async () => { if (decision?.kind === 'rejectRun') await decideRun('reject', reason); else if (decision?.kind === 'rejectFile' && decision.fileId) await decideFile(decision.fileId, 'reject', reason); else if (decision?.kind === 'rollback') { const ok = await action('rollback', { reason }, t('runDrawer.toasts.rolledBack')); if (ok) { setDecision(null); setReason('') } } }}>{tCommon('actions.confirm')}</Button></>}><div className="space-y-1.5 p-1"><Label>{t('runDrawer.reason')}</Label><Textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} /></div></Drawer>
    </UrlDrawer>
  )
}
