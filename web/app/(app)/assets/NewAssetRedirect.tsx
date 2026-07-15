'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

/**
 * Handles `?asset=new` deep links: creates the draft asset server-side and
 * swaps the URL to the real id so the flyout opens on a persisted record.
 */
export function NewAssetRedirect() {
  const t = useTranslations('assets')
  const router = useRouter()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    ;(async () => {
      const res = await fetch('/api/assets/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? t('list.createDraftFailed'))
        router.replace('/assets')
        return
      }
      router.replace(`/assets?asset=${data.id}`)
      router.refresh()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router])

  return null
}
