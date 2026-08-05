'use client'

import { useMoney } from '@/components/money-provider'
// Confirm card for a drafted (proposed) write. The
// draft tool returns a signed proposal in its output; this renders the
// journal preview + Apply/Discard. The real mutation happens only in
// /api/assistant/commit after the user clicks Apply — and lands as a DRAFT
// journal, never a posted entry.

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Check, ExternalLink, FileWarning, Sparkles } from 'lucide-react'
import { Button } from '@openbooks/ui'
type ProposalData = {
  kind: string
  preview: {
    documentDate?: string
    memo?: string | null
    lines?: { accountLabel: string; description: string | null; amount: string }[]
  }
  confirmToken: string
}

/** Extract a proposal from a tool output, if present. */
export function proposalFromOutput(output: unknown): ProposalData | null {
  if (!output || typeof output !== 'object') return null
  const o = output as Record<string, unknown>
  const data = (o.data ?? null) as Record<string, unknown> | null
  const proposed =
    data && typeof data === 'object' ? (data.proposed as ProposalData | undefined) : undefined
  if (
    proposed &&
    typeof proposed === 'object' &&
    typeof proposed.kind === 'string' &&
    typeof proposed.confirmToken === 'string'
  ) {
    return proposed
  }
  return null
}

export function ProposalCard({ proposal }: { proposal: ProposalData }) {
  const { money } = useMoney()
  const t = useTranslations('assistant')
  const [state, setState] = useState<'idle' | 'done' | 'discarded' | 'error'>('idle')
  const [result, setResult] = useState<{ documentNumber: string; href: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const lines = proposal.preview.lines ?? []

  function apply() {
    setError(null)
    start(async () => {
      try {
        const res = await fetch('/api/assistant/commit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(proposal),
        })
        const body = (await res.json()) as {
          ok?: boolean
          documentNumber?: string
          href?: string
          error?: string
        }
        if (res.ok && body.ok && body.href) {
          setResult({ documentNumber: body.documentNumber ?? '', href: body.href })
          setState('done')
        } else {
          setError(body.error ?? t('proposal.failed'))
          setState('error')
        }
      } catch {
        setError(t('proposal.failed'))
        setState('error')
      }
    })
  }

  if (state === 'discarded') {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-400 dark:border-slate-800 dark:bg-slate-900/50">
        {t('proposal.discarded')}
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-teal-200 bg-teal-50/40 dark:border-teal-900/60 dark:bg-teal-950/20">
      <div className="flex items-center gap-2 border-b border-teal-200/70 px-3 py-2 dark:border-teal-900/40">
        <Sparkles className="h-4 w-4 text-teal-600 dark:text-teal-400" />
        <span className="text-xs font-semibold tracking-wide text-teal-700 uppercase dark:text-teal-300">
          {t('proposal.title')}
        </span>
        {proposal.preview.documentDate ? (
          <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
            {proposal.preview.documentDate}
          </span>
        ) : null}
      </div>
      <div className="space-y-3 px-3 py-3">
        {proposal.preview.memo ? (
          <p className="text-sm whitespace-pre-wrap text-slate-700 dark:text-slate-200">
            {proposal.preview.memo}
          </p>
        ) : null}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] tracking-wide text-slate-400 uppercase dark:text-slate-500">
              <th className="pb-1 text-left font-medium">{t('proposal.account')}</th>
              <th className="pb-1 text-right font-medium">{t('proposal.debit')}</th>
              <th className="pb-1 text-right font-medium">{t('proposal.credit')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const amount = Number(l.amount)
              return (
                <tr key={i} className="border-t border-teal-100 dark:border-teal-900/30">
                  <td className="py-1 pr-2 text-slate-700 dark:text-slate-200">
                    {l.accountLabel}
                    {l.description ? (
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        {l.description}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1 text-right tabular-nums text-slate-700 dark:text-slate-200">
                    {amount > 0 ? money(l.amount) : ''}
                  </td>
                  <td className="py-1 text-right tabular-nums text-slate-700 dark:text-slate-200">
                    {amount < 0 ? money(-amount) : ''}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {state === 'done' && result ? (
          <div className="flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950/40 dark:text-green-300">
            <Check className="h-4 w-4" />
            {t('proposal.created', { number: result.documentNumber })}
            <Link
              href={result.href}
              className="inline-flex items-center gap-1 font-medium underline"
            >
              {t('proposal.open')} <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={apply} disabled={pending}>
              <Check className="h-4 w-4" />
              {pending ? t('proposal.applying') : t('proposal.apply')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setState('discarded')}
              disabled={pending}
            >
              {t('proposal.discard')}
            </Button>
          </div>
        )}
        {state === 'error' && error ? (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
            <FileWarning className="h-4 w-4" />
            {error}
          </div>
        ) : null}
      </div>
    </div>
  )
}
