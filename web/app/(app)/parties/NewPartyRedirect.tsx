'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

/**
 * Handles `?party=new` deep links: creates the draft party server-side
 * (instant-into-draft) and swaps the URL to the real id so the flyout opens
 * on a persisted record. `basePath`/`role` mirror NewPartyButton so an entity
 * list keeps its own path and pre-selects its role.
 */
export function NewPartyRedirect({
  basePath = '/parties',
  role,
}: {
  basePath?: string
  role?: 'customer' | 'vendor' | 'employee'
} = {}) {
  const t = useTranslations('parties.newParty')
  const router = useRouter()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    ;(async () => {
      const res = await fetch('/api/parties/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(role ? { role } : {}),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? t('createFailed'))
        router.replace(basePath)
        return
      }
      router.replace(`${basePath}?party=${data.id}&mode=edit`)
      router.refresh()
    })()
  }, [router, basePath, role, t])

  return null
}
