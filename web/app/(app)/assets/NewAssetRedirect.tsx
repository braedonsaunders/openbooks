'use client'

import { useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

/**
 * Handles `?asset=new` deep links under the unsaved-create contract: the
 * legacy instant-into-draft factory allocated a record, number, category,
 * and audit row on open, so this redirect only swaps the URL to the
 * allocation-free `?assetNew=1` drawer and writes nothing itself.
 */
export function NewAssetRedirect() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    const next = new URLSearchParams(searchParams.toString())
    next.delete('asset')
    next.set('assetNew', '1')
    const query = next.toString()
    router.replace((query ? `/assets?${query}` : '/assets?assetNew=1') as never)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router])

  return null
}
