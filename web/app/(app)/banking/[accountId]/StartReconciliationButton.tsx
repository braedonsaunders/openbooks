'use client'

import { useMoney } from '@/components/money-provider'
import { useId, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Play, Scale } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label } from '@openbooks/ui'
import { useBusinessToday } from '../../../../components/business-date-provider'
import { readApiErrorMessage } from '../../../../lib/api-error'
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
  const { money } = useMoney()
  const t = useTranslations('banking.start')
  const tBanking = useTranslations('banking')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [throughDate, setThroughDate] = useState(useBusinessToday())
  const [statementBalance, setStatementBalance] = useState('')
  const throughDateId = useId()
  const statementBalanceId = useId()

  if (openReconciliationId) {
    return (
      <Button asChild>
        <Link href={(`/banking/${accountId}/reconcile/${openReconciliationId}`)}>
          <Play size={15} /> {t('resume')}
        </Link>
      </Button>
    )
  }

  async function start() {
    setBusy(true)
    try {
      const res = await fetch('/api/banking/reconciliations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, throughDate, statementBalance }),
      })
      // The status is checked before the body parses: a non-JSON 502 page
      // must toast the translated fallback, never a SyntaxError.
      if (!res.ok) throw new Error(await readApiErrorMessage(res, tBanking('errors.startFailed')))
      const data = (await res.json()) as { id: string }
      router.push((`/banking/${accountId}/reconcile/${data.id}`))
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tBanking('errors.startFailed'))
    } finally {
      setBusy(false)
    }
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
            <Label htmlFor={throughDateId}>
              {tBanking('labels.reconcileThrough')}<span className="text-red-500"> *</span>
            </Label>
            <Input id={throughDateId} type="date" value={throughDate} onChange={(e) => setThroughDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={statementBalanceId}>
              {tBanking('labels.statementBalance')}<span className="text-red-500"> *</span>
            </Label>
            <Input
              id={statementBalanceId}
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
