'use client'

// HR-15 inbox badge: the live count on the inbox nav entry. Polls the count
// route on a 60s cadence (no websocket — the inbox is a live read model, so
// polling the same read the page renders from can never disagree with it).
// Renders nothing while the count is zero or the route is unreachable: a
// badge that cannot prove work is waiting shows nothing rather than a stale
// number.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

const POLL_MS = 60_000

export function NavCountBadge({ source }: { source: string }) {
  const t = useTranslations('shell.topNav')
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const res = await fetch(source, { headers: { Accept: 'application/json' } })
        if (!res.ok) return
        const data = await res.json().catch(() => null)
        const next = typeof data?.count === 'number' ? data.count : null
        if (alive && next !== null) setCount(next)
      } catch {
        // Unreachable route: stay silent rather than badge a guess.
      }
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [source])

  if (count === null || count <= 0) return null
  return (
    <span
      aria-label={t('itemsWaiting', { count })}
      className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-teal-700 px-1.5 text-[11px] font-semibold tabular-nums text-white dark:bg-teal-400 dark:text-teal-950"
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
