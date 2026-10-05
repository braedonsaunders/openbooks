'use client'
import { useEffect, useRef, useState } from 'react'
import { readApiErrorMessage } from '../../../lib/api-error'
import type { AnalyticsPreview } from '../../../lib/analytics/dashboard-catalog'

type PreviewState = { key: string; selection: string; data?: AnalyticsPreview; error?: string }
type PreviewQueue = { wanted: string[]; busy: () => boolean; pump: () => void }
/** Keep a bounded queue alive while cards enter the viewport. Only changing
 * the report period or leaving the page cancels running reads. */
export function useAnalyticsPreviews(slugs: readonly string[], query: string, refresh: number, fallbackError: string) {
  const [states, setStates] = useState<Record<string, PreviewState>>({})
  const current = useRef(states)
  const pending = useRef<PreviewQueue | null>(null)
  const [cycle, setCycle] = useState(0)
  const selection = `${query}:${refresh}`
  const key = `${selection}:${cycle}`
  const ids = slugs.join(',')
  useEffect(() => {
    let lastRefresh = Date.now()
    const renew = () => {
      if (document.visibilityState !== 'visible' || !pending.current?.wanted.length || pending.current.busy() || Date.now() - lastRefresh < 30_000) return
      lastRefresh = Date.now()
      setCycle((value) => value + 1)
    }
    const timer = setInterval(renew, 30_000)
    window.addEventListener('focus', renew)
    document.addEventListener('visibilitychange', renew)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', renew)
      document.removeEventListener('visibilitychange', renew)
    }
  }, [selection])
  useEffect(() => {
    const controller = new AbortController()
    const started = new Set<string>()
    let active = 0
    const publish = (slug: string, state: PreviewState) => {
      if (controller.signal.aborted) return
      current.current = { ...current.current, [slug]: state }
      setStates(current.current)
    }
    const read = async (slug: string) => {
        try {
          const response = await fetch(`/api/analytics/previews/${encodeURIComponent(slug)}${query ? `?${query}` : ''}`, { signal: controller.signal, cache: 'no-store' })
          if (!response.ok) {
            publish(slug, { key, selection, error: await readApiErrorMessage(response, fallbackError) })
            return
          }
          publish(slug, { key, selection, data: await response.json() as AnalyticsPreview })
        } catch {
          if (!controller.signal.aborted) publish(slug, { key, selection, error: fallbackError })
        } finally {
          active -= 1
          queue.pump()
        }
    }
    const queue: PreviewQueue = { wanted: [], busy: () => active > 0, pump: () => {
      if (controller.signal.aborted) return
      for (const slug of queue.wanted) {
        if (active >= 4) break
        if (started.has(slug) || current.current[slug]?.key === key) continue
        started.add(slug)
        active += 1
        void read(slug)
      }
    } }
    pending.current = queue
    return () => {
      controller.abort()
      if (pending.current === queue) pending.current = null
    }
  }, [key, selection, query, fallbackError])
  useEffect(() => {
    if (!pending.current) return
    pending.current.wanted = ids.split(',').filter(Boolean)
    pending.current.pump()
  }, [ids, key, fallbackError])
  return Object.fromEntries(Object.entries(states).filter(([, state]) => state.selection === selection))
}
