'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

/**
 * Reusable debounced async preview panel. Re-runs `load` whenever `deps` change
 * (after `debounceMs`), tracks loading / error state, ignores out-of-order
 * responses, and hands the result to `render`. App-level: any surface that wants
 * a "here's what this would do" live pane — rule builders, filter previews,
 * import dry-runs — drives it with a loader and a renderer, no fetch plumbing.
 */
export function LivePreview<T>({
  load,
  deps,
  render,
  debounceMs = 350,
  loadingLabel,
  errorLabel,
  className,
  enabled = true,
}: {
  load: (signal: AbortSignal) => Promise<T>
  deps: unknown[]
  render: (data: T, loading: boolean) => ReactNode
  debounceMs?: number
  loadingLabel?: string
  errorLabel?: string
  className?: string
  enabled?: boolean
}) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const runId = useRef(0)

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    const id = ++runId.current
    setLoading(true)
    setError(false)
    const timer = setTimeout(() => {
      load(controller.signal)
        .then((result) => {
          if (id === runId.current) {
            setData(result)
            setLoading(false)
          }
        })
        .catch((e) => {
          if (controller.signal.aborted || id !== runId.current) return
          setError(true)
          setLoading(false)
        })
    }, debounceMs)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return (
    <div className={className}>
      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{errorLabel ?? 'Preview unavailable'}</p>
      ) : data === null && loading ? (
        <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <Loader2 size={13} className="animate-spin" /> {loadingLabel ?? 'Loading…'}
        </p>
      ) : data !== null ? (
        render(data, loading)
      ) : null}
    </div>
  )
}
