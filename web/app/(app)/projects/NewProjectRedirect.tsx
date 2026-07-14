'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

/**
 * Handles `?project=new` deep links: creates the draft project server-side
 * (instant-into-draft) and swaps the URL to the real id so the flyout opens
 * on a persisted record.
 */
export function NewProjectRedirect() {
  const router = useRouter()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    ;(async () => {
      const res = await fetch('/api/projects/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Could not create a draft project')
        router.replace('/projects')
        return
      }
      router.replace(`/projects?project=${data.id}`)
      router.refresh()
    })()
  }, [router])

  return null
}
