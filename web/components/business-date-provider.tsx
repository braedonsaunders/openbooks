'use client'

import { createContext, useContext, type ReactNode } from 'react'

const BusinessDateContext = createContext<string | null>(null)

/** Org business day (YYYY-MM-DD) from the server — never the browser UTC date. */
export function BusinessDateProvider({ today, children }: { today: string; children: ReactNode }) {
  return <BusinessDateContext.Provider value={today}>{children}</BusinessDateContext.Provider>
}

export function useBusinessToday(): string {
  const today = useContext(BusinessDateContext)
  if (!today) throw new Error('useBusinessToday must be used inside BusinessDateProvider')
  return today
}
