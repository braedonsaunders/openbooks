'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'
import { promptDialog } from '@/lib/prompt'
import type { CancelRecognitionRequest } from '@/app/api/revenue/cancel-recognition/route'

/**
 * "Cancel recognition" — the dedicated cancellation workflow the invoice-void
 * refusal points at. Reverses every posted recognition journal with an exact
 * compensating entry, retires the remaining plan, and voids the source
 * invoice through the normal controlled void (ar.post). Surfaces the engine's
 * refusal verbatim when the invoice cannot be cancelled yet (for example,
 * while a credit memo is still applied to it — unapply first, then cancel).
 */
export function CancelRecognitionButton({
  documentId,
  invoiceNumber,
}: {
  documentId: string
  invoiceNumber: string
}) {
  const t = useTranslations('revenue')
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function cancel() {
    const reason = await promptDialog({
      title: t('cancel.reasonTitle'),
      label: t('cancel.reasonLabel'),
      placeholder: t('cancel.reasonPlaceholder'),
      confirmLabel: t('cancel.confirm'),
    })
    if (!reason) return
    const confirmed = await confirmDialog({
      title: t('cancel.confirmTitle'),
      message: t('cancel.confirmBody', { invoice: invoiceNumber }),
      confirmLabel: t('cancel.confirm'),
      tone: 'danger',
    })
    if (!confirmed) return
    setBusy(true)
    const requestBody = { documentId, reason } satisfies CancelRecognitionRequest
    const res = await fetch('/api/revenue/cancel-recognition', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(typeof data.error === 'string' ? data.error : t('cancel.failed'))
    } else if (res.status === 202) {
      toast.success(t('cancel.submitted'))
    } else {
      toast.success(t('cancel.done'))
    }
    setBusy(false)
    router.refresh()
  }

  return (
    <Button variant="destructive" onClick={cancel} disabled={busy}>
      {t('cancel.button')}
    </Button>
  )
}
