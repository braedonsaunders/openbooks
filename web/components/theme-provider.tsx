'use client'

// Light / dark / system theme state. The actual `.dark` class is applied before
// first paint by the inline script in the root layout (no FOUC); this provider
// owns the live preference, persists it to localStorage, re-applies the class on
// change, and follows the OS setting while in 'system' mode.

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react'
import { useHydrated } from '@/lib/use-hydrated'

export type Theme = 'light' | 'dark' | 'system'
type ResolvedTheme = 'light' | 'dark'

type ThemeContextValue = {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (t: Theme) => void
  mounted: boolean
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const STORAGE_KEY = 'theme'
const THEME_CHANGE_EVENT = 'openbooks-theme-change'
let unavailableStorageTheme: Theme | null = null

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function readTheme(): Theme {
  if (typeof window === 'undefined') return 'system'
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
  } catch {
    return unavailableStorageTheme ?? 'system'
  }
}

function subscribeTheme(onChange: () => void) {
  window.addEventListener('storage', onChange)
  window.addEventListener(THEME_CHANGE_EVENT, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(THEME_CHANGE_EVENT, onChange)
  }
}

function subscribeSystemTheme(onChange: () => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore<Theme>(subscribeTheme, readTheme, () => 'system')
  const prefersDark = useSyncExternalStore<boolean>(
    subscribeSystemTheme,
    systemPrefersDark,
    () => false,
  )
  const resolvedTheme: ResolvedTheme = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme
  const mounted = useHydrated()

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark')
  }, [resolvedTheme])

  const setTheme = useCallback((t: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, t)
      unavailableStorageTheme = null
    } catch {
      unavailableStorageTheme = t
    }
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT))
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, mounted }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>')
  return ctx
}
