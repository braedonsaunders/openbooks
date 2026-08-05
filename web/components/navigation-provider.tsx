'use client'

// Supplies a client-side navigate fn (Next's router.push) to @openbooks/ui's
// UrlDrawer via DrawerNavigateContext. Without this, UrlDrawer falls back to a
// hard navigation. Mounted once around the authenticated app shell so every
// URL-driven drawer can close by changing the URL (re-running the server
// component that owns its open state).

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { DrawerNavigateContext } from '@openbooks/ui'

export function NavigationProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const navigate = useCallback((href: string) => router.push(href as never), [router])
  return (
    <DrawerNavigateContext.Provider value={navigate}>{children}</DrawerNavigateContext.Provider>
  )
}
