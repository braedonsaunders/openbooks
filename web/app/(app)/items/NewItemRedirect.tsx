'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

/**
 * Handles `?item=new` deep links: creates the draft item server-side
 * (instant-into-draft) and swaps the URL to the real id so the flyout opens
 * on a persisted record.
 */
export function NewItemRedirect() {
  const t = useTranslations('items')
  const router = useRouter()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    ;(async () => {
      const res = await fetch('/api/items/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? t('list.createDraftFailed'))
        router.replace('/items')
        return
      }
      router.replace(`/items?item=${data.id}`)
      router.refresh()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router])

  return null
}
