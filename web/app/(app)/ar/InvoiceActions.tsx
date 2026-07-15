'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'

export function InvoiceActions({ id, status }: { id: string; status: string }) {
  const t = useTranslations('ar')
  const tCommon = useTranslations('common')
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
    if (!res.ok) toast.error(data.error ?? t('toasts.actionFailed'))
    else toast.success(action === 'submit' ? t('toasts.submitted') : t('toasts.posted'))
    setBusy(false)
    router.refresh()
  }

  if (status === 'draft') {
    return (
      <Button variant="outline" size="sm" disabled={busy} onClick={() => act('submit')}>
        {t('actions.submitForApproval')}
      </Button>
    )
  }
  if (status === 'approved') {
    return (
      <Button size="sm" disabled={busy} onClick={() => act('post')}>
        {tCommon('actions.post')}
      </Button>
    )
  }
  return null
}
