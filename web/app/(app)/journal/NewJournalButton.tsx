'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

/** Instant-into-draft: creates the draft manual journal server-side, opens its flyout. */
export function NewJournalButton() {
  const t = useTranslations('journal.newButton')
  const tc = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function create() {
    setBusy(true)
    const res = await fetch('/api/journals/draft', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('createFailed'))
      setBusy(false)
      return
    }
    router.push(`/journal?entry=${data.id}`)
    router.refresh()
    setBusy(false)
  }

  return (
    <Button onClick={create} disabled={busy}>
      <Plus size={15} /> {busy ? tc('actions.creating') : t('label')}
    </Button>
  )
}
