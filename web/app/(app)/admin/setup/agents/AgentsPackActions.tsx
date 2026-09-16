'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Loader2, Play } from 'lucide-react'
import { toast } from 'sonner'
import { Button, cn } from '@openbooks/ui'

/**
 * One pack's trailing actions for the Agents overview spec table — switch,
 * run-now, configure (the Features row order). The switch is fenced: enabling
 * while the module is off is refused client-side exactly as the server
 * refuses it with 409 `feature_disabled`. The switch round-trips the FULL
 * policy the loader hands over, so a quick toggle never resets detector
 * controls. Copy resolves here via hooks on the existing
 * `setup.agents.overview` keys, so the spec invents no message key.
 */
export function AgentsPackActions({
  agentKey,
  policy,
  packTitle,
  enabled,
  featureEnabled,
  configureHref,
  configureLabel,
}: {
  agentKey: string
  policy: Record<string, unknown>
  packTitle: string
  enabled: boolean
  featureEnabled: boolean
  configureHref: string
  configureLabel: string
}) {
  const t = useTranslations('admin')
  const router = useRouter()
  const [on, setOn] = useState(enabled)
  const [pending, setPending] = useState(false)
  const [running, setRunning] = useState(false)

  async function toggle() {
    if (pending || running) return
    const next = !on
    // The fence mirrors the server: enabling while the module is off is
    // refused with a link to the switch that unblocks it.
    if (next && !featureEnabled) return
    setOn(next)
    setPending(true)
    try {
      const res = await fetch(`/api/admin/setup/agents/${agentKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...policy, enabled: next }),
      })
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string }
        if (payload.error === 'feature_disabled') {
          throw new Error(t('setup.agents.overview.featureOffError'))
        }
        throw new Error(payload.error ?? t('setup.agents.overview.toggleFailed'))
      }
      toast.success(t(next ? 'setup.agents.overview.enabled' : 'setup.agents.overview.disabled', { name: packTitle }))
      router.refresh()
    } catch (e) {
      setOn(!next)
      toast.error((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  async function runNow() {
    if (pending || running) return
    setRunning(true)
    try {
      const res = await fetch(`/api/admin/setup/agents/${agentKey}/run`, { method: 'POST' })
      const payload = (await res.json().catch(() => ({}))) as { detected?: number }
      if (!res.ok) throw new Error(t('setup.agents.overview.scanFailed'))
      toast.success(t('setup.agents.overview.scanComplete', { count: payload.detected ?? 0 }))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <span className="flex items-center justify-end gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={packTitle}
        disabled={!featureEnabled || pending || running}
        onClick={() => void toggle()}
        className={cn(
          'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900',
          on ? 'bg-teal-600 dark:bg-teal-500' : 'bg-slate-200 dark:bg-slate-700',
          !featureEnabled || pending || running ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        )}
      >
        <span
          className={cn(
            'inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform',
            on ? 'translate-x-[18px]' : 'translate-x-0.5',
          )}
        />
      </button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!featureEnabled || !on || pending || running}
        onClick={() => void runNow()}
      >
        {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
        {t('setup.agents.overview.runNow')}
      </Button>
      <Link href={configureHref} className="shrink-0 text-xs font-medium text-teal-700 underline dark:text-teal-300">
        {configureLabel}
      </Link>
    </span>
  )
}
