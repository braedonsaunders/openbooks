'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

/**
 * Instant-into-draft: creates the draft order server-side, opens its flyout.
 * `apiPath` = /api/estimates|sales-orders|purchase-orders, `base`/`param` build
 * the list route deep-link (e.g. /estimates?estimate=<id>). `label` and
 * `createFailedMessage` arrive pre-translated from the owning list page.
 */
export function NewOrderButton({
  apiPath,
  base,
  param,
  label,
  createFailedMessage,
}: {
  apiPath: string
  base: string
  param: string
  label: string
  createFailedMessage: string
}) {
  const tCommon = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function create() {
    setBusy(true)
    const res = await fetch(`${apiPath}/draft`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? createFailedMessage)
      setBusy(false)
      return
    }
    router.push(`${base}?${param}=${data.id}&mode=edit`)
    router.refresh()
    setBusy(false)
  }

  return (
    <Button onClick={create} disabled={busy}>
      <Plus size={15} /> {busy ? tCommon('actions.creating') : label}
    </Button>
  )
}
