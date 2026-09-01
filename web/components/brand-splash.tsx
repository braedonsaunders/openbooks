'use client'

// Guarantees the brand splash stays up long enough for the draw-in animation
// to complete, even when the route resolves instantly. <SplashScreen /> is a
// fixed overlay mounted once in the root layout: it server-renders visible on
// every document load, then fades out once BOTH the minimum duration has
// elapsed AND no route fallback is holding it open. Route loading fallbacks
// mount <SplashHold /> to keep it up while content streams.
//
// The brand reveal plays ONCE per document load. app/(app)/loading.tsx is the
// Suspense fallback for the whole authenticated group, so it mounts on every
// in-app navigation that suspends; without the `played` latch below each of
// those replayed the draw-in. That matches the intent already stated in
// app/layout.tsx for the nav-internal flag — once you are inside the app there
// is no reveal to perform — which previously only covered full document loads
// and not client-side transitions. After the first cycle completes, later holds
// are inert: the shell simply keeps rendering while the next route streams.

import { useEffect, useRef, useState } from 'react'
import { cn } from '@openbooks/ui'
import { BrandSplash } from './brand-logo'

const MIN_VISIBLE_MS = 2000 // full draw-in completes at ~1.9s
const REDUCED_MOTION_MIN_MS = 500 // static logo — no reason to linger
const FADE_MS = 400

let holds = 0
// Latched once the reveal has finished for this document. Module scope, so it
// survives every client-side navigation while the tab is open and resets only
// on a real document load — exactly the lifetime the brand intro should have.
let played = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

/** Keeps the splash on screen while mounted. Render inside route loading
 *  fallbacks that should show the full-screen splash. */
export function SplashHold() {
  useEffect(() => {
    holds++
    notify()
    return () => {
      holds--
      notify()
    }
  }, [])
  return null
}

type Phase = 'visible' | 'fading' | 'gone'

export function SplashScreen() {
  const [phase, setPhase] = useState<Phase>('visible')
  const phaseRef = useRef<Phase>('visible')
  const shownAt = useRef(0) // 0 = document start, so streaming time counts

  useEffect(() => {
    let fadeT: ReturnType<typeof setTimeout> | undefined
    let goneT: ReturnType<typeof setTimeout> | undefined
    const apply = (p: Phase) => {
      phaseRef.current = p
      setPhase(p)
    }

    const sync = () => {
      clearTimeout(fadeT)
      clearTimeout(goneT)
      if (holds > 0) {
        // Once the reveal has played, a later hold must not bring it back:
        // that is the every-navigation replay. Holds arriving before the
        // splash is gone still keep the already-drawn logo up while streaming.
        if (played) return
        if (phaseRef.current !== 'visible') apply('visible')
        return
      }
      const min = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? REDUCED_MOTION_MIN_MS
        : MIN_VISIBLE_MS
      const remaining = Math.max(0, shownAt.current + min - performance.now())
      fadeT = setTimeout(() => {
        apply('fading')
        goneT = setTimeout(() => {
          played = true
          apply('gone')
        }, FADE_MS)
      }, remaining)
    }

    listeners.add(sync)
    // Opened from within the app (in-app link in a new tab)? Skip the brand
    // intro entirely on this load — go straight to gone before paint reveals
    // anything — and clear the flag so it cannot leak into a later load. A route
    // fallback already holding it open wins.
    const html = document.documentElement
    const internal = html.classList.contains('nav-internal')
    html.classList.remove('nav-internal')
    if (internal && holds === 0) {
      played = true
      apply('gone')
    } else {
      sync()
    }
    return () => {
      listeners.delete(sync)
      clearTimeout(fadeT)
      clearTimeout(goneT)
    }
  }, [])

  if (phase === 'gone') return null
  return (
    <div
      aria-hidden
      data-splash-root
      className={cn(
        'fixed inset-0 z-[100] transition-opacity ease-out',
        phase === 'visible' ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
      style={{ transitionDuration: `${FADE_MS}ms` }}
    >
      <BrandSplash />
    </div>
  )
}
