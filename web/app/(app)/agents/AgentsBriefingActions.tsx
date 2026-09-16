'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Mail, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

/**
 * The briefing tab's ONLY interactive layer: generate + send-as-email over
 * /api/agents/briefing, then refresh. The cached narrative, its heading, and
 * the empty state are server-rendered spec blocks around it — this island
 * owns no panel chrome and renders no markdown.
 */
export function AgentsBriefingActions({
  aiEnabled,
  hasBriefing,
  generateLabel,
  generatingLabel,
  sendLabel,
  sentLabel,
  sendFailedLabel,
  failedLabel,
  errorLabels,
}: {
  aiEnabled: boolean
  hasBriefing: boolean
  generateLabel: string
  generatingLabel: string
  sendLabel: string
  sentLabel: string
  sendFailedLabel: string
  failedLabel: string
  errorLabels: Record<string, string>
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<'generate' | 'send' | null>(null)

  async function run(action: 'generate' | 'send') {
    setBusy(action)
    try {
      const response = await fetch('/api/agents/briefing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean
        emailed?: boolean
        error?: string
      } | null
      if (!response.ok || !body?.ok) {
        toast.error(errorLabels[body?.error ?? 'failed'] ?? failedLabel)
        return
      }
      if (action === 'send') {
        if (body.emailed) toast.success(sentLabel)
        else toast.error(sendFailedLabel)
      }
      router.refresh()
    } catch {
      toast.error(failedLabel)
    } finally {
      setBusy(null)
    }
  }

  if (!aiEnabled) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant={hasBriefing ? 'outline' : 'default'}
        size={hasBriefing ? 'sm' : 'md'}
        disabled={busy !== null}
        onClick={() => void run('generate')}
      >
        <Sparkles size={14} />{busy === 'generate' ? generatingLabel : generateLabel}
      </Button>
      {hasBriefing ? (
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void run('send')}>
          <Mail size={13} />{sendLabel}
        </Button>
      ) : null}
    </div>
  )
}
