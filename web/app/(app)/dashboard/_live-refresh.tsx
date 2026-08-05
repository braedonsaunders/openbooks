'use client'

import { useRouter } from 'next/navigation'
import { startTransition, useEffect } from 'react'

const REFRESH_INTERVAL_MS = 60_000

/**
 * Server-rendered dashboard balances are authoritative at request time, but a
 * browser tab can otherwise keep that payload forever while imports, payments,
 * and background mirrors continue posting. Refresh only while the dashboard is
 * visible, and refresh a stale tab as soon as it regains focus.
 */
export function DashboardLiveRefresh() {
  const router = useRouter()

  useEffect(() => {
    let refreshedAt = Date.now()

    const refreshIfStale = () => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - refreshedAt < REFRESH_INTERVAL_MS) return
      refreshedAt = now
      startTransition(() => router.refresh())
    }

    const interval = window.setInterval(refreshIfStale, REFRESH_INTERVAL_MS)
    document.addEventListener('visibilitychange', refreshIfStale)
    window.addEventListener('focus', refreshIfStale)

    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', refreshIfStale)
      window.removeEventListener('focus', refreshIfStale)
    }
  }, [router])

  return null
}
