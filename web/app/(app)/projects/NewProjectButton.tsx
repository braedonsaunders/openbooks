'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

/**
 * Instant-into-draft: creates the inactive project server-side, opens its flyout.
 */
export function NewProjectButton({ label = 'New project' }: { label?: string } = {}) {
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function create() {
    setBusy(true)
    const res = await fetch('/api/projects/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? 'Could not create a draft project')
      setBusy(false)
      return
    }
    router.push(`/projects?project=${data.id}`)
    router.refresh()
    setBusy(false)
  }

  return (
    <Button onClick={create} disabled={busy}>
      <Plus size={15} /> {busy ? 'Creating…' : label}
    </Button>
  )
}
