'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Check, FileWarning, ShieldCheck } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { ApiResponseError, apiJson } from '@/lib/api-error'
import { confirmDialog } from '@/lib/confirm'

export interface ProposedApplicationCommand {
  toolName: string
  title: string
  destructive: boolean
  input: Record<string, unknown>
  confirmToken: string
}

/** Window event dispatched after a command card is applied, so live side panels re-read state. */
export const APPLICATION_COMMAND_APPLIED_EVENT = 'openbooks:application-command-applied'

/** Best-effort notice to live panels; the command is already applied whether or not anyone listens. */
function announceApplied(toolName: string) {
  if (typeof window === 'undefined' || typeof window.CustomEvent !== 'function') return
  window.dispatchEvent(new window.CustomEvent(APPLICATION_COMMAND_APPLIED_EVENT, { detail: { toolName } }))
}

export function applicationCommandFromOutput(output: unknown): ProposedApplicationCommand | null {
  if (!output || typeof output !== 'object') return null
  const data = (output as { data?: unknown }).data
  if (!data || typeof data !== 'object') return null
  const proposal = (data as { proposedApplicationCommand?: unknown }).proposedApplicationCommand
  if (!proposal || typeof proposal !== 'object') return null
  const value = proposal as Partial<ProposedApplicationCommand>
  if (
    typeof value.toolName !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.destructive !== 'boolean' ||
    !value.input || typeof value.input !== 'object' || Array.isArray(value.input) ||
    typeof value.confirmToken !== 'string'
  ) return null
  return value as ProposedApplicationCommand
}

export function ApplicationCommandCard({ proposal }: { proposal: ProposedApplicationCommand }) {
  const t = useTranslations('assistant.applicationCommand')
  const [state, setState] = useState<'idle' | 'applied' | 'discarded' | 'error'>('idle')
  const [result, setResult] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function apply() {
    startTransition(async () => {
      if (proposal.destructive) {
        const confirmed = await confirmDialog({
          message: t('confirmDestructive', { title: proposal.title }),
          tone: 'danger',
        })
        if (!confirmed) return
      }
      setError(null)
      try {
        const body = await apiJson<Record<string, unknown>>(
          '/api/assistant/application-command',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(proposal),
          },
          t('commandFailed'),
        )
        setResult(body)
        setState('applied')
      } catch (error) {
        setError(error instanceof ApiResponseError ? error.message : t('failed'))
        setState('error')
        return
      }
      announceApplied(proposal.toolName)
    })
  }

  if (state === 'discarded') {
    return <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900/50">{t('discarded')}</div>
  }

  return (
    <div className={proposal.destructive
      ? 'overflow-hidden rounded-xl border border-amber-300 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20'
      : 'overflow-hidden rounded-xl border border-teal-200 bg-teal-50/40 dark:border-teal-900/60 dark:bg-teal-950/20'}>
      <div className="flex items-center gap-2 border-b border-current/10 px-3 py-2">
        {proposal.destructive
          ? <AlertTriangle className="h-4 w-4 text-amber-600" />
          : <ShieldCheck className="h-4 w-4 text-teal-600" />}
        <span className="text-xs font-semibold tracking-wide uppercase">{t('reviewRequired')}</span>
        <span className="ml-auto text-xs font-medium">{proposal.title}</span>
      </div>
      <div className="space-y-3 px-3 py-3">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t('proposed')}
        </p>
        <pre className="max-h-72 overflow-auto rounded-md bg-white p-2 text-xs leading-relaxed text-slate-700 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-300 dark:ring-slate-800">
          {JSON.stringify(proposal.input, null, 2)}
        </pre>
        {state === 'applied' ? (
          <div className="space-y-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950/40 dark:text-green-300">
            <div className="flex items-center gap-2"><Check className="h-4 w-4" />{t('applied')}</div>
            <pre className="max-h-60 overflow-auto text-xs">{JSON.stringify(result, null, 2)}</pre>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={apply} disabled={pending}>
              <Check className="h-4 w-4" />{pending ? t('applying') : t('apply')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setState('discarded')} disabled={pending}>
              {t('discard')}
            </Button>
          </div>
        )}
        {state === 'error' && error ? (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
            <FileWarning className="h-4 w-4" />{error}
          </div>
        ) : null}
      </div>
    </div>
  )
}
