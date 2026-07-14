'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

export function InvoiceActions({ id, status }: { id: string; status: string }) {
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function act(action: 'submit' | 'post') {
    setBusy(true)
    const res = await fetch('/api/invoices/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, documentId: id }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? 'Action failed')
    else toast.success(action === 'submit' ? 'Submitted for approval' : 'Posted to the ledger')
    setBusy(false)
    router.refresh()
  }

  if (status === 'draft') {
    return (
      <Button variant="outline" size="sm" disabled={busy} onClick={() => act('submit')}>
        Submit for approval
      </Button>
    )
  }
  if (status === 'approved') {
    return (
      <Button size="sm" disabled={busy} onClick={() => act('post')}>
        Post
      </Button>
    )
  }
  return null
}
