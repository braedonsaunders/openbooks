'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

/**
 * Handles `?party=new` deep links: creates the draft party server-side
 * (instant-into-draft) and swaps the URL to the real id so the flyout opens
 * on a persisted record.
 */
export function NewPartyRedirect() {
  const router = useRouter()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    ;(async () => {
      const res = await fetch('/api/parties/draft', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Could not create a draft party')
        router.replace('/parties')
        return
      }
      router.replace(`/parties?party=${data.id}`)
      router.refresh()
    })()
  }, [router])

  return null
}
