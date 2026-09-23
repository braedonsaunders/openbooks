'use client'

import { useRef, useState } from 'react'
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
  const [total, setTotal] = useState(0)
  const [cursor, setCursor] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const queryRef = useRef('')
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

  // The picker reads posted vouchers from the server — filtered, searched,
  // and paged there, never truncated client-side. With 50 newer reversed
  // vouchers, an older still-posted one arrives on a later page instead of
  // vanishing from the only reversal picker.
  async function fetchVouchers(nextQuery: string, nextCursor: string | null, append: boolean): Promise<void> {
    const params = new URLSearchParams({ view: 'landed', status: 'posted', limit: '50' })
    if (nextQuery.trim()) params.set('q', nextQuery.trim())
    if (nextCursor) params.set('cursor', nextCursor)
    const res = await fetch(`/api/inventory/advanced?${params.toString()}`)
    if (!res.ok) {
      throw new Error(await readApiErrorMessage(res, t('advanced.landed.reverse.loadFailed')))
    }
    const data = await res.json()
    const page = ((data.vouchers ?? []) as VoucherOpt[]).filter((v) => v.status === 'posted')
    setVouchers((prev) => (append ? [...prev, ...page] : page))
    setTotal(typeof data.totalCount === 'number' ? data.totalCount : page.length)
    setCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null)
  }

  async function openDialog() {
    setOpen(true)
    setSubmitError(null)
    setDate(today)
    queryRef.current = ''
    setVouchers([])
    setCursor(null)
    try {
      await fetchVouchers('', null, false)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t('advanced.landed.reverse.loadFailed'))
    }
  }

  function searchVouchers(next: string) {
    // SearchSelect re-announces '' every time its menu opens; only a real
    // query change refetches page one from the server.
    if (queryRef.current === next) return
    queryRef.current = next
    setSearching(true)
    setSubmitError(null)
    void (async () => {
      try {
        await fetchVouchers(next, null, false)
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : t('advanced.landed.reverse.loadFailed'))
      } finally {
        setSearching(false)
      }
    })()
  }

  function loadMore() {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    setSubmitError(null)
    void (async () => {
      try {
        await fetchVouchers(queryRef.current, cursor, true)
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : t('advanced.landed.reverse.loadFailed'))
      } finally {
        setLoadingMore(false)
      }
    })()
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
              remote
              loading={searching}
              onSearchChange={searchVouchers}
            />
            {vouchers.length === 0 && !submitError && !searching ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('advanced.landed.reverse.nonePosted')}</p>
            ) : null}
            {cursor ? (
              <div className="flex justify-center py-1">
                <Button variant="secondary" size="sm" disabled={loadingMore} onClick={loadMore}>
                  {loadingMore ? t('counts.list.loadingMore') : t('counts.list.showMore', { loaded: vouchers.length, total })}
                </Button>
              </div>
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
