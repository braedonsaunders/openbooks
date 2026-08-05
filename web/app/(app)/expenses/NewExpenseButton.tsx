'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

/** Instant-into-draft: creates the draft expense report server-side, opens its flyout. */
export function NewExpenseButton() {
  const t = useTranslations('expenses')
  const tCommon = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function create() {
    setBusy(true)
    const res = await fetch('/api/expenses/draft', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('toasts.draftFailed'))
      setBusy(false)
      return
    }
    router.push(`/expenses/reports?expense=${data.id}&mode=edit`)
    router.refresh()
    setBusy(false)
  }

  return (
    <Button onClick={create} disabled={busy}>
      <Plus size={15} /> {busy ? tCommon('actions.creating') : t('actions.newReport')}
    </Button>
  )
}
