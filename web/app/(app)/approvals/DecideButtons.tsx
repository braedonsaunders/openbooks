'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

export function DecideButtons({ requestId, stepNumber }: { requestId: string; stepNumber: number }) {
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function go(decision: 'approved' | 'rejected') {
    const note = decision === 'rejected' ? (prompt('Rejection reason:') ?? undefined) : undefined
    if (decision === 'rejected' && !note) return
    setBusy(true)
    const res = await fetch('/api/approvals/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, stepNumber, decision, note }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? 'Decision failed')
    else toast.success(decision === 'approved' ? 'Approved' : 'Rejected')
    setBusy(false)
    router.refresh()
  }

  return (
    <span className="inline-flex gap-2">
      <Button size="sm" disabled={busy} onClick={() => go('approved')}>
        Approve
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => go('rejected')}>
        Reject
      </Button>
    </span>
  )
}
