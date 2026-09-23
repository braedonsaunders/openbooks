'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label, SearchSelect, Textarea } from '@openbooks/ui'
import { useBusinessToday } from '@/components/business-date-provider'
import { readApiErrorMessage } from '../../../lib/api-error'

interface VoucherOpt {
  id: string
  documentNumber?: string | null
  status?: string | null
  amount?: string | null
  voucherDate?: string | null
}

const field = 'space-y-1.5'

/**
 * Reverse a posted landed-cost voucher. The original voucher, its
 * allocations, and its journal stay intact; the engine appends negative
 * allocation evidence and a mirrored contra journal plus an audit row.
 * Restricted callers only ever see (and can only reverse) vouchers of the
 * subsidiaries they may see — enforced server-side on both the list and the
 * reversal.
 */
export function ReverseLandedVoucherAction() {
  const t = useTranslations('inventory')
  const router = useRouter()
  const today = useBusinessToday()

  const [open, setOpen] = useState(false)
  const [vouchers, setVouchers] = useState<VoucherOpt[]>([])
  const [voucherId, setVoucherId] = useState('')
  const [date, setDate] = useState(today)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [key, setKey] = useState(() => crypto.randomUUID())

  const voucherOptions = vouchers.map((v) => ({
    value: v.id,
    label: `${v.documentNumber ?? v.id} · ${v.voucherDate ?? ''} · ${v.amount ?? ''}`.trim(),
  }))

  async function openDialog() {
    setOpen(true)
    setSubmitError(null)
    setDate(today)
    try {
      const res = await fetch('/api/inventory/advanced?view=landed')
      if (!res.ok) {
        throw new Error(await readApiErrorMessage(res, t('advanced.landed.reverse.loadFailed')))
      }
      const data = await res.json()
      setVouchers(((data.vouchers ?? []) as VoucherOpt[]).filter((v) => v.status === 'posted'))
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t('advanced.landed.reverse.loadFailed'))
    }
  }

  function touchKey() {
    setKey(crypto.randomUUID())
  }

  async function submit() {
    if (!voucherId) {
      setSubmitError(t('advanced.landed.reverse.voucherRequired'))
      return
    }
    if (reason.trim().length < 5 || reason.trim().length > 500) {
      setSubmitError(t('advanced.landed.reverse.reasonLength'))
      return
    }
    setBusy(true)
    setSubmitError(null)
    try {
      const res = await fetch('/api/inventory/advanced', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'reverseLandedVoucher',
          id: voucherId,
          date,
          memo: reason.trim(),
          idempotencyKey: key,
        }),
      })
      if (!res.ok) {
        throw new Error(await readApiErrorMessage(res, t('advanced.landed.reverse.reverseFailed')))
      }
      const data = await res.json()
      toast.success(
        data.alreadyReversed
          ? t('advanced.landed.reverse.alreadyReversed')
          : t('advanced.landed.reverse.reversed'),
      )
      touchKey()
      setOpen(false)
      router.refresh()
    } catch (error) {
      const detail = error instanceof Error ? error.message : t('advanced.landed.reverse.reverseFailed')
      setSubmitError(detail)
      toast.error(detail)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button variant="outline" onClick={openDialog}>
        {t('advanced.landed.reverse.openButton')}
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={t('advanced.landed.reverse.title')}
        description={t('advanced.landed.reverse.description')}
        footer={
          <Button disabled={busy} onClick={submit}>
            {t('advanced.landed.reverse.reverse')}
          </Button>
        }
      >
        <div className="space-y-5 p-1">
          {submitError ? (
            <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              {submitError}
            </p>
          ) : null}
          <div className={field}>
            <Label>{t('advanced.landed.reverse.voucher')}<span className="text-red-500"> *</span></Label>
            <SearchSelect
              value={voucherId}
              onChange={(v) => { setVoucherId(v); touchKey() }}
              options={voucherOptions}
              placeholder={t('advanced.landed.reverse.selectVoucher')}
              sheetTitle={t('advanced.landed.reverse.voucher')}
              ariaLabel={t('advanced.landed.reverse.voucher')}
            />
            {vouchers.length === 0 && !submitError ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('advanced.landed.reverse.nonePosted')}</p>
            ) : null}
          </div>
          <div className={field}>
            <Label>{t('advanced.landed.reverse.reversalDate')}<span className="text-red-500"> *</span></Label>
            <Input type="date" value={date} onChange={(e) => { setDate(e.target.value); touchKey() }} />
          </div>
          <div className={field}>
            <Label>{t('advanced.landed.reverse.reason')}<span className="text-red-500"> *</span></Label>
            <Textarea
              value={reason}
              onChange={(e) => { setReason(e.target.value); touchKey() }}
              placeholder={t('advanced.landed.reverse.reasonPlaceholder')}
            />
          </div>
        </div>
      </Drawer>
    </>
  )
}
