'use client'

// Shared open-state for the mobile nav drawer so both the hamburger (top bar)
// and the "Menu" tab (bottom tab bar) can drive the same drawer.

import { createContext, useContext, useState, type ReactNode } from 'react'

const Ctx = createContext<{ open: boolean; setOpen: (v: boolean) => void } | null>(null)

export function MobileNavProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return <Ctx.Provider value={{ open, setOpen }}>{children}</Ctx.Provider>
}

export function useMobileNav() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useMobileNav must be used within MobileNavProvider')
  return ctx
}
