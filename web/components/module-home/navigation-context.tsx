'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import type { LocalNavigationPreferences } from '@openbooks/engine/navigation'
import type { ViewTabGroup, ViewTabOwnership } from './view-tab-match'

export const ViewTabsContext = createContext<{ groups: readonly ViewTabGroup[]; managed: boolean; preferences?: LocalNavigationPreferences; ownership?: readonly ViewTabOwnership[] } | null>(null)

export function ViewTabsProvider({ groups, children, managed = false, preferences, ownership }: {
  groups: readonly ViewTabGroup[]
  children: ReactNode
  managed?: boolean
  preferences?: LocalNavigationPreferences
  ownership?: readonly ViewTabOwnership[]
}) {
  return <ViewTabsContext.Provider value={{ groups, managed, preferences, ownership }}>{children}</ViewTabsContext.Provider>
}

/** Legacy header switches cannot duplicate a centrally owned local row. */
export function useManagedLocalNavigation(): boolean {
  const context = useContext(ViewTabsContext)
  const pathname = usePathname()
  return Boolean(context?.managed && pathname && (context.ownership ?? context.groups.flat()).some((tab) => {
    const path = tab.href.split('?')[0]!
    return path === pathname || (tab.prefix && pathname.startsWith(`${path}/`))
  }))
}
