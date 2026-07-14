'use client'

// Mobile hamburger for the main app menu. On <lg the app nav rail is hidden;
// this button opens it as an animated slide-in drawer (portal to body, spring,
// backdrop fade, Esc + click-out + scroll-lock — matches the @openbooks/ui Drawer).

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Menu, X } from 'lucide-react'
import { Badge } from '@openbooks/ui'
import { Logo } from './brand-logo'
import { useMobileNav } from './mobile-nav'
import { SidebarNav, type SidebarNavGroup } from './sidebar-nav'
import { useNavGroups } from './use-platform-nav'
import { ThemeToggle } from './theme-toggle'
import { useHydrated } from '@/lib/use-hydrated'

export function MobileNavToggle({ groups }: { groups: SidebarNavGroup[] }) {
  const { open, setOpen } = useMobileNav()
  const navGroups = useNavGroups(groups)
  const mounted = useHydrated()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, setOpen])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-slate-200 text-slate-600 transition-colors hover:bg-slate-50 lg:hidden dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        <Menu size={18} />
      </button>

      {mounted
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <div className="fixed inset-0 z-50 lg:hidden">
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
                    onClick={() => setOpen(false)}
                  />
                  <motion.aside
                    initial={{ x: '-100%' }}
                    animate={{ x: 0 }}
                    exit={{ x: '-100%' }}
                    transition={{ type: 'spring', damping: 32, stiffness: 320, mass: 0.8 }}
                    className="absolute top-0 left-0 flex h-full w-72 max-w-[86%] flex-col border-r border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
                    onClickCapture={(e) => {
                      if ((e.target as HTMLElement).closest('a')) setOpen(false)
                    }}
                  >
                    <div className="flex h-14 items-center justify-between border-b border-slate-200 px-4 dark:border-slate-800">
                      <Logo className="h-7 w-auto" />
                      <button
                        type="button"
                        onClick={() => setOpen(false)}
                        aria-label="Close"
                        className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                      >
                        <X size={18} />
                      </button>
                    </div>
                    <SidebarNav groups={navGroups} />

                    {/* Footer: theme switcher + build tag — mirrors the desktop
                        rail. Safe-area padding clears the iOS home indicator. */}
                    <div className="space-y-2 border-t border-slate-200 px-3 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] dark:border-slate-800">
                      <ThemeToggle />
                      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                        <span>v0.1.0</span>
                        <Badge variant="secondary" className="font-mono text-[10px]">
                          dev
                        </Badge>
                      </div>
                    </div>
                  </motion.aside>
                </div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </>
  )
}
