'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

export function CloseButtons({ periodId, module, closed }: { periodId: string; module: string; closed: boolean }) {
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function act(action: 'close' | 'reopen') {
    if (action === 'reopen' && !confirm(`Reopen ${module.toUpperCase()} for this period?`)) return
    setBusy(true)
    const res = await fetch('/api/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ periodId, module, action }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? 'Action failed')
    else toast.success(`${module.toUpperCase()} ${action === 'close' ? 'closed' : 'reopened'}`)
    setBusy(false)
    router.refresh()
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-xs"
      disabled={busy}
      onClick={() => act(closed ? 'reopen' : 'close')}
    >
      {closed ? 'Reopen' : 'Close'}
    </Button>
  )
}
