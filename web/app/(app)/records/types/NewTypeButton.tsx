'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

/** Instant-into-draft: creates the draft record type server-side, opens its builder flyout. */
export function NewTypeButton() {
  const t = useTranslations('records.types')
  const tc = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function create() {
    setBusy(true)
    const res = await fetch('/api/records/types', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('createFailed'))
      setBusy(false)
      return
    }
    router.push(`/records/types?type=${data.id}`)
    router.refresh()
    setBusy(false)
  }

  return (
    <Button onClick={create} disabled={busy}>
      <Plus size={15} /> {busy ? tc('actions.creating') : t('newButton')}
    </Button>
  )
}
