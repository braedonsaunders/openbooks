'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import type { DocKindConfig } from '../lib/document-kinds'

/**
 * Inline submit/post actions for a document list row. Direct-post kinds
 * (card charges, checks, transfers) expose Post from draft; approval-routed
 * kinds expose Submit for approval from draft and Post once approved.
 */
export function DocumentRowActions({
  id,
  status,
  config,
}: {
  id: string
  status: string
  config: DocKindConfig
}) {
  const t = useTranslations(config.i18n)
  const tCommon = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function act(action: 'submit' | 'post') {
    setBusy(true)
    const res = await fetch('/api/documents/actions', {
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
      <Button variant="outline" size="sm" disabled={busy} onClick={() => act(config.directPost ? 'post' : 'submit')}>
        {config.directPost ? tCommon('actions.post') : t('actions.submitForApproval')}
      </Button>
    )
  }
  if (status === 'approved' && !config.directPost) {
    return (
      <Button size="sm" disabled={busy} onClick={() => act('post')}>
        {tCommon('actions.post')}
      </Button>
    )
  }
  return null
}
