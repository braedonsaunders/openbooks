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
    try {
      const res = await fetch('/api/expenses/draft', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? t('toasts.draftFailed'))
      if (!data.id) throw new Error(t('toasts.draftFailed'))
      router.push(`/expenses/reports?expense=${data.id}&mode=edit`)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('toasts.draftFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button onClick={create} disabled={busy}>
      <Plus size={15} /> {busy ? tCommon('actions.creating') : t('actions.newReport')}
    </Button>
  )
}
