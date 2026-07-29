'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

/**
 * Instant-into-draft: creates the inactive party server-side, opens its flyout.
 * `basePath` keeps the flyout on the current list (e.g. /entities/customers);
 * `role` pre-enables that role so the new record belongs to the list it was
 * created from. Both default to the shared Parties directory.
 */
export function NewPartyButton({
  basePath = '/parties',
  role,
  label,
}: {
  basePath?: string
  role?: 'customer' | 'vendor' | 'employee'
  label?: string
} = {}) {
  const t = useTranslations('parties.newParty')
  const tc = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function create() {
    setBusy(true)
    const res = await fetch('/api/parties/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(role ? { role } : {}),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('createFailed'))
      setBusy(false)
      return
    }
    router.push(`${basePath}?party=${data.id}&mode=edit`)
    router.refresh()
    setBusy(false)
  }

  return (
    <Button onClick={create} disabled={busy}>
      <Plus size={15} /> {busy ? tc('actions.creating') : (label ?? t('defaultLabel'))}
    </Button>
  )
}
