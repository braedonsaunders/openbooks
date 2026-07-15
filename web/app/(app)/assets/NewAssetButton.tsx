'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

/** Instant-into-draft: creates the draft asset server-side, opens its flyout. */
export function NewAssetButton({ label }: { label?: string } = {}) {
  const t = useTranslations('assets')
  const tCommon = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function create() {
    setBusy(true)
    const res = await fetch('/api/assets/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('list.createDraftFailed'))
      setBusy(false)
      return
    }
    router.push(`/assets?asset=${data.id}`)
    router.refresh()
    setBusy(false)
  }

  return (
    <Button onClick={create} disabled={busy}>
      <Plus size={15} /> {busy ? tCommon('actions.creating') : (label ?? t('list.newButton'))}
    </Button>
  )
}
