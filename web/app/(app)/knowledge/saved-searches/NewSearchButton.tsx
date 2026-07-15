'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'

/** Instant-into-draft: create a private draft owned by the caller, open it. */
export function NewSearchButton() {
  const t = useTranslations('knowledge.savedSearches')
  const tc = useTranslations('common')
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function create() {
    setBusy(true)
    const res = await fetch('/api/saved-searches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const data = await res.json()
    setBusy(false)
    if (!res.ok) {
      toast.error(data.error ?? tc('feedback.createFailed'))
      return
    }
    router.push(`/knowledge/saved-searches?search=${data.id}`)
    router.refresh()
  }

  return (
    <Button disabled={busy} onClick={create}>
      <Plus size={16} /> {t('new')}
    </Button>
  )
}
