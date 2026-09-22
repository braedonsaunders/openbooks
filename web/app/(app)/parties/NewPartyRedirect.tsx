'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { mergeHref } from '../../../lib/list-params'

/**
 * Handles `?party=new` deep links with zero writes: swaps the URL to the
 * unsaved-create drawer (`?partyNew=1`) so the flyout opens on an editable
 * draft that is persisted only by its explicit Save. `basePath`/`role`
 * mirror NewPartyButton so an entity list keeps its own path and
 * pre-selects its role.
 */
export function NewPartyRedirect({
  basePath = '/parties',
  role,
}: {
  basePath?: string
  role?: 'customer' | 'vendor' | 'employee'
} = {}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const current = Object.fromEntries(searchParams.entries())
    router.replace(mergeHref(basePath, current, {
      party: undefined,
      partyNew: '1',
      ...(role ? { role } : {}),
    }) as never)
  }, [router, searchParams, basePath, role])

  return null
}
