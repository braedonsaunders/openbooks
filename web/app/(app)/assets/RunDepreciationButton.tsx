'use client'

import { useMoney } from '@/components/money-provider'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Play } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Label, Popover, Select } from '@openbooks/ui'
/**
 * List-level "Run depreciation" — posts all due, unposted period entries
 * through the kernel (assets.manage). Idempotent, so a repeat click that finds
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
    const res = await fetch('/api/assets/run-depreciation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(assetId ? { assetId } : {}), bookId }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('drawer.runFailed'))
      setBusy(false)
      return
    }
    if (data.posted > 0) {
      toast.success(
        t('run.posted', { count: data.posted, amount: money(data.totalAmount) }) +
          (data.skipped > 0 ? ` · ${t('run.someSkipped', { count: data.skipped })}` : ''),
      )
    } else {
      toast.message(t('run.nothingDue') + (data.skipped > 0 ? ` · ${t('run.someSkipped', { count: data.skipped })}` : ''))
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
    trigger={<Button variant={assetId ? 'outline' : 'default'} disabled={busy}><Play size={15} /> {t('list.runDepreciation')}</Button>}
  >
    <div className="w-72 space-y-3 p-3">
      <div className="space-y-1.5"><Label htmlFor="depreciation-book">{t('run.book')}</Label><Select id="depreciation-book" value={bookId} onChange={(event) => setBookId(event.target.value)}>{books.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}</Select></div>
      <Button className="w-full" onClick={run} disabled={busy || !bookId}>{t('run.postBook')}</Button>
    </div>
  </Popover>
}
