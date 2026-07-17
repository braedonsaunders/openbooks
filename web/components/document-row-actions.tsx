'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { BookCheck, Eye, LoaderCircle, Send } from 'lucide-react'
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
  openHref,
}: {
  id: string
  status: string
  config: DocKindConfig
  openHref: string
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
    const label = config.directPost ? tCommon('actions.post') : t('actions.submitForApproval')
    return (
      <Button variant="outline" size="icon" className="h-7 w-7" disabled={busy} onClick={() => act(config.directPost ? 'post' : 'submit')} aria-label={label} title={label}>
        {busy ? <LoaderCircle size={14} className="animate-spin" /> : config.directPost ? <BookCheck size={14} /> : <Send size={14} />}
      </Button>
    )
  }
  if (status === 'approved' && !config.directPost) {
    return (
      <Button size="icon" className="h-7 w-7" disabled={busy} onClick={() => act('post')} aria-label={tCommon('actions.post')} title={tCommon('actions.post')}>
        {busy ? <LoaderCircle size={14} className="animate-spin" /> : <BookCheck size={14} />}
      </Button>
    )
  }
  return (
    <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
      <Link href={openHref} aria-label={tCommon('actions.open')} title={tCommon('actions.open')}><Eye size={14} /></Link>
    </Button>
  )
}
