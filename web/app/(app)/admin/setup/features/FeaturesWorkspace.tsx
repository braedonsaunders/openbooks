'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { cn } from '@openbooks/ui'

/** Toggle-card grid — QBO's "Enable features" page, with plain-language
 * descriptions of what each switch turns on. Saves on toggle (no save
 * button); nav updates on next render. */
export function FeaturesWorkspace(props: { features: { key: string; enabled: boolean }[] }) {
  const t = useTranslations('admin')
  const router = useRouter()
  const [state, setState] = useState<Record<string, boolean>>(
    () => Object.fromEntries(props.features.map((f) => [f.key, f.enabled])),
  )
  const [busy, setBusy] = useState(false)

  async function toggle(key: string) {
    const next = !state[key]
    setState((s) => ({ ...s, [key]: next }))
    setBusy(true)
    try {
      const res = await fetch('/api/admin/setup/features', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features: { [key]: next } }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'failed')
      toast.success(t(next ? 'setup.features.enabled' : 'setup.features.disabled', { name: t(`features.${key}.title`) }))
      router.refresh()
    } catch (e) {
      setState((s) => ({ ...s, [key]: !next }))
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {props.features.map((f) => (
        <button
          key={f.key}
          type="button"
          disabled={busy}
          onClick={() => toggle(f.key)}
          className={cn(
            'rounded-lg border p-4 text-left transition-colors',
            state[f.key]
              ? 'border-teal-500 bg-teal-50/60 dark:border-teal-500 dark:bg-teal-950/30'
              : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700',
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t(`features.${f.key}.title`)}
            </span>
            {/* switch */}
            <span
              aria-hidden
              className={cn(
                'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
                state[f.key] ? 'bg-teal-600 dark:bg-teal-500' : 'bg-slate-300 dark:bg-slate-600',
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all',
                  state[f.key] ? 'left-[18px]' : 'left-0.5',
                )}
              />
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
            {t(`features.${f.key}.description`)}
          </p>
        </button>
      ))}
    </div>
  )
}
