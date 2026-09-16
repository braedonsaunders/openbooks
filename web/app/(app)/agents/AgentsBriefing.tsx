'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Mail, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { ChatMarkdown } from '@/components/assistant/markdown'

/**
 * Morning briefing panel: the cached per-day narrative (or a generate CTA),
 * rendered in the chat's markdown, with Generate and Send-as-email actions.
 * Generation and delivery run through /api/agents/briefing; the island only
 * triggers and refreshes.
 */
export function AgentsBriefing({
  briefing,
  aiEnabled,
}: {
  briefing: { text: string; generatedAt: string; role: string } | null
  aiEnabled: boolean
}) {
  const t = useTranslations('agents')
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
        emailError?: string
        error?: string
      } | null
      if (!response.ok || !body?.ok) {
        toast.error(t(`briefing.errors.${body?.error ?? 'failed'}`))
        return
      }
      if (action === 'send') {
        if (body.emailed) toast.success(t('briefing.sent'))
        else toast.error(t('briefing.sendFailed'))
      }
      router.refresh()
    } catch {
      toast.error(t('briefing.errors.failed'))
    } finally {
      setBusy(null)
    }
  }

  if (!briefing) {
    return (
      <section className="space-y-3 rounded-xl border border-dashed border-slate-200 bg-white p-6 text-center dark:border-slate-800 dark:bg-slate-900">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {aiEnabled ? t('briefing.empty') : t('briefing.noAi')}
        </p>
        {aiEnabled ? (
          <Button disabled={busy !== null} onClick={() => void run('generate')}>
            <Sparkles size={14} />{busy === 'generate' ? t('briefing.generating') : t('briefing.generate')}
          </Button>
        ) : null}
      </section>
    )
  }

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t('briefing.generatedAt', {
            date: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
              new Date(briefing.generatedAt),
            ),
          })}
        </p>
        <span className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void run('generate')}>
            <Sparkles size={13} />{busy === 'generate' ? t('briefing.generating') : t('briefing.generate')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void run('send')}>
            <Mail size={13} />{t('briefing.send')}
          </Button>
        </span>
      </div>
      <ChatMarkdown>{briefing.text}</ChatMarkdown>
    </section>
  )
}
