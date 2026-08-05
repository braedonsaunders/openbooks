'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { BookCheck, Eye, LoaderCircle, Send } from 'lucide-react'

export function ExpenseActions({
  id,
  status,
  canSubmit,
  canPost,
  openHref,
}: {
  id: string
  status: string
  canSubmit: boolean
  canPost: boolean
  openHref: string
}) {
  const t = useTranslations('expenses')
  const tCommon = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function act(action: 'submit' | 'post') {
    setBusy(true)
    const res = await fetch('/api/expenses/actions', {
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

  if (status === 'draft' && canSubmit) {
    const label = t('actions.submitForApproval')
    return (
      <Button variant="outline" size="icon" className="h-7 w-7" disabled={busy} onClick={() => act('submit')} aria-label={label} title={label}>
        {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Send size={14} />}
      </Button>
    )
  }
  if (status === 'approved' && canPost) {
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
