'use client'

import { useEffect, useEffectEvent, useState } from 'react'

/** A detail request depends only on its URL. Navigation callbacks and other
 * overlay state may change without discarding a record already being read. */
export function useDrawerResource<T>(url: string | null, onError: (error: Error) => void) {
  const reportError = useEffectEvent(onError)
  const [resource, setResource] = useState<{ url: string | null; data: T | null }>({ url, data: null })
  if (resource.url !== url) setResource({ url, data: null })
  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    fetch(url, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: unknown } | null
          throw new Error(typeof body?.error === 'string' ? body.error : `Unable to load the record (${response.status}).`)
        }
        return await response.json() as T
      })
      .then((data) => { if (!controller.signal.aborted) setResource({ url, data }) })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setResource({ url, data: null })
          reportError(error instanceof Error ? error : new Error(String(error)))
        }
      })
    return () => controller.abort()
  }, [url])
  return resource.url === url ? resource.data : null
}
