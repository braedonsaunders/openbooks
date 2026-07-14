'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

/** Instant-into-draft: allocates the numbered draft record server-side, opens its flyout. */
export function NewRecordButton({ typeKey, typeName }: { typeKey: string; typeName: string }) {
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function create() {
    setBusy(true)
    const res = await fetch(`/api/records/${typeKey}/draft`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? `Could not create a draft ${typeName.toLowerCase()}`)
      setBusy(false)
      return
    }
    router.push(`/records/${typeKey}?rec=${data.id}`)
    router.refresh()
    setBusy(false)
  }

  return (
    <Button onClick={create} disabled={busy}>
      <Plus size={15} /> {busy ? 'Creating…' : `New ${typeName.toLowerCase()}`}
    </Button>
  )
}
