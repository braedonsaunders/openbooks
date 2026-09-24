'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { BookCheck, Eye, LoaderCircle, Send } from 'lucide-react'
import { throwApiErrorIfNotOk } from '../../../lib/api-error'

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
    try {
      const res = await fetch('/api/expenses/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, documentId: id }),
      })
      await throwApiErrorIfNotOk(res, t('toasts.actionFailed'))
      toast.success(action === 'submit' ? t('toasts.submitted') : t('toasts.posted'))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('toasts.actionFailed'))
    } finally {
      setBusy(false)
    }
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
