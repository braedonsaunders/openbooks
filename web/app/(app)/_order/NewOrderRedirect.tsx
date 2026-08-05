'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

/**
 * Handles `?<param>=new` deep links: creates the draft order server-side and
 * swaps the URL to the real id so the flyout opens on a persisted record.
 * `createFailedMessage` arrives pre-translated from the owning list page.
 */
export function NewOrderRedirect({
  apiPath,
  base,
  param,
  createFailedMessage,
}: {
  apiPath: string
  base: string
  param: string
  createFailedMessage: string
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
        toast.error(data.error ?? createFailedMessage)
        router.replace(base)
        return
      }
      router.replace(`${base}?${param}=${data.id}&mode=edit`)
      router.refresh()
    })()
  }, [router, apiPath, base, param, createFailedMessage])

  return null
}
