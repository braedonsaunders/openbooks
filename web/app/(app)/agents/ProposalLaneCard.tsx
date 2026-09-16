import Link from 'next/link'
import { Badge } from '@openbooks/ui'
import { ApplicationCommandCard } from '@/components/assistant/application-command-card'
import type { FindingProposalCommand } from '@/lib/agents/proposals'

/**
 * One proposals-lane card: the finding's context over the SAME governed
 * review card the chat uses (ApplicationCommandCard posts to the same
 * /api/assistant/application-command route with idempotency + audit — never
 * a second write path). When the carried command does not resolve for this
 * viewer (assistant-side tool, invalid input, out-of-gate), the finding still
 * renders with an unavailable note instead of a dead Apply.
 */
export function ProposalLaneCard({
  title,
  href,
  summary,
  packLabel,
  severityLabel,
  severityVariant,
  materiality,
  detected,
  proposal,
  unavailableLabel,
}: {
  title: string
  href: string
  summary: string
  packLabel: string
  severityLabel: string
  severityVariant: 'secondary' | 'warning' | 'destructive'
  materiality: string
  detected: string
  proposal: FindingProposalCommand | null
  unavailableLabel: string
}) {
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{packLabel}</Badge>
        <Badge variant={severityVariant}>{severityLabel}</Badge>
        <span className="ml-auto text-sm font-medium tabular-nums">{materiality}</span>
      </div>
      <div>
        <Link href={href as never} className="font-medium text-slate-900 hover:text-teal-700 hover:underline dark:text-slate-100 dark:hover:text-teal-300">{title}</Link>
        <p className="mt-0.5 text-xs text-slate-500">{summary} · {detected}</p>
      </div>
      {proposal ? (
        <ApplicationCommandCard proposal={proposal} />
      ) : (
        <p className="text-xs text-slate-500 dark:text-slate-400">{unavailableLabel}</p>
      )}
    </section>
  )
}
