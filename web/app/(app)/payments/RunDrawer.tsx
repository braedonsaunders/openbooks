'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Download } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle, Badge, Button, UrlDrawer } from '@openbooks/ui'
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
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const closeHref = '/payments?view=runs'
  const blockerByInstruction = new Map(blockers.map((b) => [b.instructionId, b.reason]))
  const live = instructions.filter((i) => i.status !== 'cancelled')
  const total = live.reduce((acc, i) => acc + Number(i.amount), 0)
  const canExport = eftConfigured && blockers.length === 0 && (run.status === 'draft' || run.status === 'exported')
  const canPost = run.status === 'exported'
  const canCancel = run.status === 'draft' || run.status === 'exported'

  async function postRun() {
    const ok = await confirmDialog({
      message: `Post ${live.filter((i) => i.status === 'pending').length} payment(s) totalling ${money(total)} to the ledger and apply them to the selected bills?`,
    })
    if (!ok) return
    setBusy(true)
    const res = await fetch(`/api/payments/runs/${run.id}/post`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? 'Posting failed')
    } else if (data.failures?.length) {
      toast.error(
        `${data.posted} posted; failed: ${data.failures.map((f: any) => `${f.payee} (${f.error})`).join('; ')}`,
      )
    } else {
      toast.success(`${data.posted} payment(s) posted and applied`)
    }
    setBusy(false)
    router.refresh()
  }

  async function cancelRun() {
    const ok = await confirmDialog({
      message: `Cancel run ${run.run_number}? Its draft payments are deleted; nothing has posted.`,
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    const res = await fetch(`/api/payments/runs/${run.id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? 'Could not cancel the run')
    else toast.success('Run cancelled')
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
          <Badge variant={RUN_VARIANT[run.status] ?? 'secondary'}>{String(run.status).replace('_', ' ')}</Badge>
        </span>
      }
      description={`EFT from ${`${run.bank_number ?? ''} ${run.bank_name ?? ''}`.trim() || 'bank account'}${run.scheduled_for ? ` · funds ${run.scheduled_for}` : ''}`}
      headerActions={
        <>
          {canCancel ? (
            <Button variant="outline" disabled={busy} onClick={cancelRun}>
              Cancel run
            </Button>
          ) : null}
          {run.status === 'draft' || run.status === 'exported' ? (
            canExport ? (
              <Button variant={canPost ? 'outline' : 'default'} asChild>
                <a
                  href={`/api/payments/runs/${run.id}/file`}
                  download
                  onClick={() => setTimeout(() => router.refresh(), 800)}
                >
                  <Download size={15} /> Download CPA-005 file
                </a>
              </Button>
            ) : (
              <Button disabled title="Resolve the EFT configuration / bank-detail issues first">
                <Download size={15} /> Download CPA-005 file
              </Button>
            )
          ) : null}
          {canPost ? (
            <Button disabled={busy} onClick={postRun}>
              {busy ? 'Posting…' : 'Post payments'}
            </Button>
          ) : null}
        </>
      }
      footer={
        <div className="flex w-full flex-wrap items-center gap-3">
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            {live.length} payment{live.length === 1 ? '' : 's'} ·{' '}
            <strong className="text-slate-900 dark:text-slate-100">Total {money(total)}</strong>
          </span>
        </div>
      }
    >
      <div className="space-y-4 p-1">
        {!eftConfigured ? (
          <Alert variant="warning">
            <AlertTitle>EFT origination is not configured</AlertTitle>
            <AlertDescription>
              The CPA-005 file cannot be generated until an administrator sets{' '}
              <code className="font-mono text-xs">orgs.settings.eft</code> — missing:{' '}
              {eftMissing.join(', ')}. Placeholders can be seeded with{' '}
              <code className="font-mono text-xs">engine/src/seed-eft-settings.ts</code>, then filled with the
              bank-assigned originator details.
            </AlertDescription>
          </Alert>
        ) : null}
        {blockers.length > 0 && run.status !== 'cancelled' && run.status !== 'confirmed' ? (
          <Alert variant="destructive">
            <AlertTitle>Payees missing approved bank details</AlertTitle>
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
                <th className="px-3 py-2">Payee</th>
                <th className="px-3 py-2">Payment</th>
                <th className="px-3 py-2">Bank details</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Amount</th>
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
                      <Badge variant="success">approved</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={INSTRUCTION_VARIANT[i.status] ?? 'secondary'}>{i.status}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(i.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </UrlDrawer>
  )
}
