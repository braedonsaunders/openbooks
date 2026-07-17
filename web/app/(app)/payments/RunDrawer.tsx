'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Download, Send } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle, Badge, Button, Drawer, Label, Select, UrlDrawer } from '@openbooks/ui'
import { confirmDialog } from '../../../lib/confirm'
import { money } from '../../../lib/format'

/**
 * Payment-run flyout: instructions, EFT readiness, and the two explicit
 * actions — CPA-005 file download (draft → exported) and posting the run's
 * payments + applications (exported → confirmed).
 */

const RUN_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline' | 'default'> = {
  confirmed: 'success',
  exported: 'default',
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
const INSTRUCTION_STATUS_KEYS = ['pending', 'sent', 'settled', 'returned', 'cancelled']

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
}: {
  run: Record<string, any>
  instructions: Record<string, any>[]
  eftConfigured: boolean
  eftMissing: string[]
  blockers: RunBlockerClient[]
}) {
  const t = useTranslations('payments')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [deliverOpen, setDeliverOpen] = useState(false)
  const [sftpServers, setSftpServers] = useState<{ id: string; name: string }[]>([])
  const [sftpServerId, setSftpServerId] = useState('')
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
    if (status === 'confirmed' || status === 'exported') return t(`runs.status.${status}`)
    const key = RUN_STATUS_COMMON_KEY[status]
    return key ? tCommon(`status.${key}`) : status.replace('_', ' ')
  }
  const blockerByInstruction = new Map(blockers.map((b) => [b.instructionId, b.reason]))
  const live = instructions.filter((i) => i.status !== 'cancelled')
  const total = live.reduce((acc, i) => acc + Number(i.amount), 0)
  const canExport = eftConfigured && blockers.length === 0 && (run.status === 'draft' || run.status === 'exported')
  const canPost = run.status === 'exported'
  const canCancel = run.status === 'draft' || run.status === 'exported'

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
          {run.status === 'draft' || run.status === 'exported' ? (
            canExport ? (
              <>
                <Button variant={canPost ? 'outline' : 'default'} asChild>
                  <a
                    href={`/api/payments/runs/${run.id}/file`}
                    download
                    onClick={() => setTimeout(() => router.refresh(), 800)}
                  >
                    <Download size={15} /> {t('runDrawer.downloadFile')}
                  </a>
                </Button>
                <Button variant="outline" disabled={busy} onClick={openDeliver}>
                  <Send size={15} /> {t('runDrawer.deliverSftp')}
                </Button>
              </>
            ) : (
              <Button disabled title={t('runDrawer.downloadBlockedTitle')}>
                <Download size={15} /> {t('runDrawer.downloadFile')}
              </Button>
            )
          ) : null}
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
            <AlertTitle>{t('eft.notConfiguredTitle')}</AlertTitle>
            <AlertDescription>
              {t('eft.notConfiguredDrawerDescription', { missing: eftMissing.join(', ') })}
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
              {instructions.map((i) => (
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
    </UrlDrawer>
  )
}
