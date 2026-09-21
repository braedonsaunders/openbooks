'use client'

import { readApiErrorMessage } from '@/lib/api-error'

import { useMoney } from '@/components/money-provider'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Play } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Label, Popover, Select } from '@openbooks/ui'
/**
 * List-level "Run depreciation" — recognizes due amounts in the selected
 * book, with kernel entries only for GL-posting books (assets.manage). Idempotent, so a repeat click that finds
 * nothing due simply reports zero.
 */
export function RunDepreciationButton({
  assetId,
  books,
}: {
  assetId?: string
  books: { id: string; name: string; is_primary?: boolean }[]
}) {
  const { money } = useMoney()
  const t = useTranslations('assets')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [bookId, setBookId] = useState(books.find((book) => book.is_primary)?.id ?? books[0]?.id ?? '')

  async function run() {
    setBusy(true)
    // A transport or parse failure must toast like any other failure — an
    // uncaught rejection leaves the button spinning with zero feedback.
    let data: { posted?: number; recorded?: number; recordedAmount?: string; skipped?: number; totalAmount?: string; problems?: unknown; error?: string; asOfDate?: string; nextDue?: { assetNumber: string; period: string; endsOn: string; amount: string } | null }
    try {
      const res = await fetch('/api/assets/run-depreciation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(assetId ? { assetId } : {}), bookId }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('drawer.runFailed')))
        setBusy(false)
        return
      }
      data = await res.json()
    } catch {
      toast.error(t('drawer.runFailed'))
      setBusy(false)
      return
    }
    const posted = data.posted ?? 0
    const recorded = data.recorded ?? 0
    const skipped = data.skipped ?? 0
    if (posted > 0 || recorded > 0) {
      const messages = [
        ...(posted > 0 ? [t('run.posted', { count: posted, amount: money(data.totalAmount ?? '0') })] : []),
        ...(recorded > 0 ? [t('run.recorded', { count: recorded, amount: money(data.recordedAmount ?? '0') })] : []),
        ...(skipped > 0 ? [t('run.someSkipped', { count: skipped })] : []),
      ]
      toast.success(messages.join(' · '))
    } else if (skipped === 0 && data.nextDue) {
      // A mid-period run posts nothing while a planned line waits in the open
      // period: name the as-of date and the next due line (F-t07-005).
      toast.message(t('run.nextDue', {
        date: data.asOfDate ?? '',
        asset: data.nextDue.assetNumber,
        period: data.nextDue.period,
        amount: money(data.nextDue.amount ?? '0'),
        endsOn: data.nextDue.endsOn,
      }))
    } else {
      toast.message(t('run.nothingDue') + (skipped > 0 ? ` · ${t('run.someSkipped', { count: skipped })}` : ''))
    }
    if (Array.isArray(data.problems) && data.problems.length) {
      for (const p of data.problems.slice(0, 3)) toast.warning(String(p))
    }
    setBusy(false)
    setOpen(false)
    router.refresh()
  }

  if (books.length <= 1) return <Button variant={assetId ? 'outline' : 'default'} onClick={run} disabled={busy || !bookId}><Play size={15} /> {t('list.runDepreciation')}</Button>
  return <Popover
    open={open}
    onOpenChange={setOpen}
    trigger={<Button variant={assetId ? 'outline' : 'default'} disabled={busy} onClick={() => setOpen((v) => !v)}><Play size={15} /> {t('list.runDepreciation')}</Button>}
  >
    <div className="w-72 space-y-3 p-3">
      <div className="space-y-1.5"><Label htmlFor="depreciation-book">{t('run.book')}</Label><Select id="depreciation-book" value={bookId} onChange={(event) => setBookId(event.target.value)}>{books.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}</Select></div>
      <Button className="w-full" onClick={run} disabled={busy || !bookId}>{t('run.postBook', { book: books.find((book) => book.id === bookId)?.name ?? '' })}</Button>
    </div>
  </Popover>
}
