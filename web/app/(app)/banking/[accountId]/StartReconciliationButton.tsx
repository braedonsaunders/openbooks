'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Play, Scale } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label } from '@openbooks/ui'
import { money } from '../../../../lib/format'

/**
 * Start a reconciliation session (through date + bank statement balance),
 * or resume the account's open one — one open session per account.
 */
export function StartReconciliationButton({
  accountId,
  openReconciliationId,
  glBalance,
}: {
  accountId: string
  openReconciliationId: string | null
  glBalance: string
}) {
  const t = useTranslations('banking.start')
  const tBanking = useTranslations('banking')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [throughDate, setThroughDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [statementBalance, setStatementBalance] = useState('')

  if (openReconciliationId) {
    return (
      <Button asChild>
        <Link href={`/banking/${accountId}/reconcile/${openReconciliationId}` as any}>
          <Play size={15} /> {t('resume')}
        </Link>
      </Button>
    )
  }

  async function start() {
    setBusy(true)
    const res = await fetch('/api/banking/reconciliations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, throughDate, statementBalance }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? tBanking('errors.startFailed'))
      setBusy(false)
      return
    }
    router.push(`/banking/${accountId}/reconcile/${data.id}` as any)
    router.refresh()
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Scale size={15} /> {t('button')}
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title={t('title')}
        description={t('description')}
        headerActions={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {tCommon('actions.cancel')}
            </Button>
            <Button disabled={busy || !throughDate || statementBalance.trim() === '' || Number.isNaN(Number(statementBalance))} onClick={start}>
              {busy ? t('starting') : t('start')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>
              {tBanking('labels.reconcileThrough')}<span className="text-red-500"> *</span>
            </Label>
            <Input type="date" value={throughDate} onChange={(e) => setThroughDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>
              {tBanking('labels.statementBalance')}<span className="text-red-500"> *</span>
            </Label>
            <Input
              inputMode="decimal"
              value={statementBalance}
              onChange={(e) => setStatementBalance(e.target.value)}
              placeholder="0.00"
              className="text-right tabular-nums"
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t.rich('currentGlBalance', {
                amount: money(glBalance),
                amt: (chunks) => <span className="tabular-nums">{chunks}</span>,
              })}
            </p>
          </div>
        </div>
      </Drawer>
    </>
  )
}
