'use client'

import { useTranslations } from 'next-intl'
import { UnsavedCreateButton } from '@/components/unsaved-create-button'

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
  return (
    <UnsavedCreateButton
      base={basePath}
      param="partyNew"
      clear={['party']}
      label={label ?? t('defaultLabel')}
      extra={role ? { role } : undefined}
    />
  )
}
