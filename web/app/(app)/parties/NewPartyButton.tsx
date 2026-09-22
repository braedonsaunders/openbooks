'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { mergeHref } from '../../../lib/list-params'

/**
 * Unsaved-create: opens a URL-controlled unsaved drawer (`?partyNew=1`).
 * Zero writes on open — the party is persisted only by the drawer's explicit
 * Save (one idempotent POST to /api/parties). `basePath` keeps the drawer on
 * the current list (e.g. /entities/customers); `role` pre-selects that role
 * so the new record belongs to the list it was created from. Both default to
 * the shared Parties directory.
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
  const router = useRouter()
  const searchParams = useSearchParams()
  const current = Object.fromEntries(searchParams.entries())

  function open() {
    router.push(mergeHref(basePath, current, {
      party: undefined,
      partyNew: '1',
      ...(role ? { role } : {}),
    }) as never)
  }

  return (
    <Button onClick={open}>
      <Plus size={15} /> {label ?? t('defaultLabel')}
    </Button>
  )
}
