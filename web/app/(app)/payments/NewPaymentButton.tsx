'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

/** Instant-into-draft: creates the draft payment server-side, opens its flyout. */
export function NewPaymentButton({
  kind,
  basePath,
  label,
}: {
  kind: 'vendor_payment' | 'customer_payment'
  basePath: string
  label: string
}) {
  const t = useTranslations('payments.newButton')
  const tCommon = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function create() {
    setBusy(true)
    const res = await fetch('/api/payments/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('createDraftFailed'))
      setBusy(false)
      return
    }
    router.push(`${basePath}?payment=${data.id}` as any)
    router.refresh()
    setBusy(false)
  }

  return (
    <Button onClick={create} disabled={busy}>
      <Plus size={15} /> {busy ? tCommon('actions.creating') : label}
    </Button>
  )
}
