'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'

export function DecideButtons({ requestId, stepNumber }: { requestId: string; stepNumber: number }) {
  const t = useTranslations('approvals.decide')
  const tc = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function go(decision: 'approved' | 'rejected') {
    const note =
      decision === 'rejected' ? (prompt(t('rejectionReason')) ?? undefined) : undefined
    if (decision === 'rejected' && !note) return
    setBusy(true)
    const res = await fetch('/api/approvals/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, stepNumber, decision, note }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? t('decisionFailed'))
    else toast.success(decision === 'approved' ? tc('status.approved') : tc('status.rejected'))
    setBusy(false)
    router.refresh()
  }

  return (
    <span className="inline-flex gap-2">
      <Button size="sm" disabled={busy} onClick={() => go('approved')}>
        {tc('actions.approve')}
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => go('rejected')}>
        {tc('actions.reject')}
      </Button>
    </span>
  )
}
