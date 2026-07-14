'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

/**
 * Handles `?<param>=new` deep links: creates the draft order server-side and
 * swaps the URL to the real id so the flyout opens on a persisted record.
 */
export function NewOrderRedirect({
  apiPath,
  base,
  param,
}: {
  apiPath: string
  base: string
  param: string
}) {
  const router = useRouter()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    ;(async () => {
      const res = await fetch(`${apiPath}/draft`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Could not create a draft')
        router.replace(base)
        return
      }
      router.replace(`${base}?${param}=${data.id}`)
      router.refresh()
    })()
  }, [router, apiPath, base, param])

  return null
}
