'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

/**
 * Instant-into-draft: creates the inactive item server-side, opens its flyout.
 */
export function NewItemButton({ label = 'New item' }: { label?: string } = {}) {
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function create() {
    setBusy(true)
    const res = await fetch('/api/items/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? 'Could not create a draft item')
      setBusy(false)
      return
    }
    router.push(`/items?item=${data.id}`)
    router.refresh()
    setBusy(false)
  }

  return (
    <Button onClick={create} disabled={busy}>
      <Plus size={15} /> {busy ? 'Creating…' : label}
    </Button>
  )
}
