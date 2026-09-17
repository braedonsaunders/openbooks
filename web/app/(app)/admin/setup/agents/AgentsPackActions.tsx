'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Loader2, Play } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { Switch } from '@/components/switch'
import { postAgentScan } from './run-agent-scan'

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
      const outcome = await postAgentScan(agentKey)
      if (!outcome.ok) {
        if (outcome.alreadyRunning) {
          // Another run owns the scan: say so and converge the row onto
          // its progress instead of reporting a generic failure.
          toast.error(t('setup.agents.overview.scanAlreadyRunning'))
          router.refresh()
          return
        }
        throw new Error(t('setup.agents.overview.scanFailed'))
      }
      toast.success(t('setup.agents.overview.scanComplete', { count: outcome.detected }))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <span className="flex items-center justify-end gap-2">
      <Switch
        on={on}
        disabled={!featureEnabled || pending || running}
        onToggle={() => void toggle()}
        label={packTitle}
      />
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
