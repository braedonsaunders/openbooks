'use client'

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { LogoMark } from './brand-logo'
import { SkeletonTransition } from './route-transitions'
import {
  finishNavigationPending,
  commitNavigationHref,
  holdPagePending,
  navigationPendingServerSnapshot,
  navigationPendingSnapshot,
  subscribeNavigationPending,
} from '../lib/navigation-pending'

function PendingLogo() {
  const t = useTranslations('common.actions')
  return (
    <div role="status" aria-live="polite" className="page-pending-logo grid place-items-center">
      <LogoMark draw className="relative z-10 h-12 w-auto" />
      <span className="sr-only">{t('loading')}</span>
    </div>
  )
}

/** Streaming fallback stays inside the shell and never holds a completed page. */
export function PagePending() {
  useEffect(holdPagePending, [])
  return (
    <SkeletonTransition>
      <div data-page-pending className="page-pending-surface grid min-h-48 flex-1 place-items-center" aria-busy="true">
        <PendingLogo />
      </div>
    </SkeletonTransition>
  )
}

/** Existing content remains mounted while same-route server work is pending. */
export function NavigationPendingBoundary({ children }: { children: ReactNode }) {
  const { navigation, fallbacks } = useSyncExternalStore(subscribeNavigationPending, navigationPendingSnapshot, navigationPendingServerSnapshot)
  const [visibleSequence, setVisibleSequence] = useState<number | null>(null)
  useEffect(() => {
    if (!navigation) return
    // Feedback has no minimum duration. Cached/instant views commit before
    // this threshold without flashing a loader or delaying their navigation.
    const timer = setTimeout(() => setVisibleSequence(navigation.sequence), 120)
    return () => clearTimeout(timer)
  }, [navigation])
  const visible = Boolean(navigation && visibleSequence === navigation.sequence && fallbacks === 0)
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" aria-busy={Boolean(navigation) || fallbacks > 0}>
      {children}
      {visible ? (
        <div data-navigation-pending className="page-pending-surface pointer-events-none absolute inset-0 z-40 grid place-items-center">
          <PendingLogo />
        </div>
      ) : null}
    </div>
  )
}

/** Page identity is separate from observer re-renders and presentation history. */
export function NavigationCommit({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const previous = useRef<{ children: ReactNode; key: string } | null>(null)
  useLayoutEffect(() => {
    const key = `${pathname}${search ? `?${search}` : ''}`
    const navigation = navigationPendingSnapshot().navigation
    const changedContent = previous.current !== null && previous.current.children !== children
    const changedAddress = previous.current !== null && previous.current.key !== key
    // The new payload also settles redirects and refreshes; a pathname/search
    // observer alone would miss an error rendering at the existing address.
    if (navigation && (navigation.href === key || changedContent || changedAddress)) finishNavigationPending()
    commitNavigationHref(key)
    previous.current = { children, key }
  }, [children, pathname, search])
  return children
}

/** Refusals may replace the page without changing its address or payload key. */
export function NavigationRefusalSettled() {
  useLayoutEffect(finishNavigationPending, [])
  return null
}
