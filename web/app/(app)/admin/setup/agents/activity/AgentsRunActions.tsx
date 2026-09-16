'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Loader2, Play } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

/**
 * One run's row actions for the Agents activity spec table: the findings link
 * plus re-run (the overview run-now precedent — POST to the per-pack run
 * route, toast, `router.refresh()` so the server-paged table reloads).
 * Copy resolves here via hooks on the existing `setup.agents` keys.
 */
export function AgentsRunActions({
  agentKey,
  findingsHref,
  findingsLabel,
}: {
  agentKey: string
  findingsHref: string
  findingsLabel: string
}) {
  const t = useTranslations('admin')
  const router = useRouter()
  const [running, setRunning] = useState(false)

  async function rerun() {
    if (running) return
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
    <span className="flex items-center justify-end gap-3 whitespace-nowrap">
      <Link href={findingsHref} className="font-medium text-teal-700 underline dark:text-teal-300">
        {findingsLabel}
      </Link>
      <Button type="button" variant="outline" size="sm" disabled={running} onClick={() => void rerun()}>
        {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
        {t('setup.agents.activity.rerun')}
      </Button>
    </span>
  )
}
