'use client'

import { useMoney } from '@/components/money-provider'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useState } from 'react'
import { Check, ExternalLink, RotateCcw, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Textarea, UrlDrawer } from '@openbooks/ui'
type Evidence = {
  id: string
  kind: string
  sourceType: string | null
  sourceId: string | null
  data: Record<string, unknown>
}

export type ContinuousCloseWorkItem = {
  id: string
  agentKey: 'accounting' | 'finance'
  findingType: string
  severity: 'info' | 'warning' | 'critical'
  status: 'open' | 'in_review' | 'resolved' | 'dismissed'
  confidence: string
  materiality: string
  summary: Record<string, unknown>
  firstDetectedAt: string
  lastDetectedAt: string
  dismissalReason: string | null
  evidence: Evidence[]
  feedback: 'helpful' | 'not_helpful' | null
}

const SEVERITY_VARIANT = { info: 'secondary', warning: 'warning', critical: 'destructive' } as const
const STATUS_VARIANT = { open: 'warning', in_review: 'secondary', resolved: 'success', dismissed: 'outline' } as const

function text(value: unknown): string {
  return value == null ? '—' : String(value)
}

export function WorkItemDrawer({
  item,
  closeHref,
  canWrite,
}: {
  item: ContinuousCloseWorkItem
  closeHref: string
  canWrite: boolean
}) {
  const { money } = useMoney()
  const t = useTranslations('continuousClose')
  const locale = useLocale()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [dismissMode, setDismissMode] = useState(false)
  const [reason, setReason] = useState('')
  const [feedback, setFeedback] = useState(item.feedback)
  const href = typeof item.summary.href === 'string' ? item.summary.href : null
  const aiAnalysis = item.summary.aiAnalysis && typeof item.summary.aiAnalysis === 'object' && !Array.isArray(item.summary.aiAnalysis)
    ? item.summary.aiAnalysis as Record<string, unknown>
    : null

  async function mutate(action: 'review' | 'resolve' | 'dismiss' | 'reopen') {
    setBusy(true)
    try {
      const response = await fetch(`/api/continuous-close/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, reason: action === 'dismiss' ? reason : undefined }),
      })
      if (!response.ok) throw new Error()
      toast.success(t(`feedback.${action}`))
      router.refresh()
      if (action === 'dismiss') setDismissMode(false)
    } catch {
      toast.error(t('feedback.actionFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function rate(rating: 'helpful' | 'not_helpful') {
    try {
      const response = await fetch(`/api/continuous-close/items/${item.id}/feedback`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating }),
      })
      if (!response.ok) throw new Error()
      setFeedback(rating)
      toast.success(t('feedback.recorded'))
    } catch {
      toast.error(t('feedback.actionFailed'))
    }
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="lg"
      title={t(`findings.${item.findingType}.title` as never)}
      description={t(`findings.${item.findingType}.description` as never)}
      footer={canWrite ? (
        <div className="flex w-full flex-wrap justify-end gap-2">
          {item.status === 'open' ? <Button variant="outline" disabled={busy} onClick={() => void mutate('review')}>{t('actions.startReview')}</Button> : null}
          {item.status === 'open' || item.status === 'in_review' ? <Button disabled={busy} onClick={() => void mutate('resolve')}><Check size={14} />{t('actions.resolve')}</Button> : null}
          {item.status === 'open' || item.status === 'in_review' ? <Button variant="outline" className="text-red-600" disabled={busy} onClick={() => setDismissMode(true)}>{t('actions.dismiss')}</Button> : null}
          {item.status === 'resolved' || item.status === 'dismissed' ? <Button variant="outline" disabled={busy} onClick={() => void mutate('reopen')}><RotateCcw size={14} />{t('actions.reopen')}</Button> : null}
        </div>
      ) : undefined}
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={SEVERITY_VARIANT[item.severity]}>{t(`severity.${item.severity}`)}</Badge>
          <Badge variant={STATUS_VARIANT[item.status]}>{t(`status.${item.status}`)}</Badge>
          <Badge variant="outline">{t(`agents.${item.agentKey}`)}</Badge>
        </div>

        <dl className="grid gap-3 rounded-xl border border-slate-200 p-4 sm:grid-cols-3 dark:border-slate-800">
          <div><dt className="text-[11px] font-medium uppercase text-slate-500">{t('details.materiality')}</dt><dd className="mt-1 font-semibold tabular-nums">{money(item.materiality)}</dd></div>
          <div><dt className="text-[11px] font-medium uppercase text-slate-500">{t('details.confidence')}</dt><dd className="mt-1 font-semibold tabular-nums">{Math.round(Number(item.confidence) * 100)}%</dd></div>
          <div><dt className="text-[11px] font-medium uppercase text-slate-500">{t('details.lastDetected')}</dt><dd className="mt-1 text-sm">{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.lastDetectedAt))}</dd></div>
        </dl>

        {aiAnalysis ? (
          <section className="space-y-3 rounded-xl border border-violet-200 bg-violet-50/60 p-4 dark:border-violet-900 dark:bg-violet-950/20">
            <div className="flex items-center gap-2">
              <Sparkles size={15} className="text-violet-600 dark:text-violet-400" />
              <h3 className="text-sm font-semibold">{t('analysis.title')}</h3>
            </div>
            {aiAnalysis.headline ? <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{text(aiAnalysis.headline)}</h4> : null}
            {aiAnalysis.explanation ? <p className="text-sm leading-6 text-slate-700 dark:text-slate-300">{text(aiAnalysis.explanation)}</p> : null}
            <AnalysisList title={t('analysis.rootCauses')} values={aiAnalysis.rootCauses} />
            <AnalysisList title={t('analysis.recommendations')} values={aiAnalysis.recommendations} />
            {Array.isArray(aiAnalysis.citations) && aiAnalysis.citations.length ? (
              <div className="flex flex-wrap gap-2 pt-1">
                {aiAnalysis.citations.map((citation, index) => {
                  if (!citation || typeof citation !== 'object' || Array.isArray(citation)) return null
                  const row = citation as Record<string, unknown>
                  if (typeof row.href !== 'string' || !row.href.startsWith('/') || typeof row.label !== 'string') return null
                  return <Button key={`${row.href}-${index}`} variant="outline" size="sm" asChild><Link href={row.href as never}>{row.label}<ExternalLink size={12} /></Link></Button>
                })}
              </div>
            ) : null}
            <p className="text-[11px] text-violet-700/80 dark:text-violet-300/80">{t('analysis.evidenceNotice')}</p>
          </section>
        ) : null}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('details.summary')}</h3>
          <FindingSummary item={item} />
          {href ? <Button variant="outline" size="sm" asChild><Link href={href as never}>{t('actions.openSource')}<ExternalLink size={13} /></Link></Button> : null}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('details.evidence')}</h3>
          {item.evidence.length === 0 ? (
            <p className="text-sm text-slate-500">{t('details.noEvidence')}</p>
          ) : (
            <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
              {item.evidence.map((evidence) => <EvidenceRow key={evidence.id} evidence={evidence} />)}
            </div>
          )}
        </section>

        {item.dismissalReason ? (
          <section className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-xs font-semibold">{t('details.dismissalReason')}</h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{item.dismissalReason}</p>
          </section>
        ) : null}

        {dismissMode ? (
          <section className="space-y-3 rounded-lg border border-red-200 bg-red-50/50 p-4 dark:border-red-900 dark:bg-red-950/20">
            <div><h3 className="text-sm font-semibold">{t('dismiss.title')}</h3><p className="mt-1 text-xs text-slate-500">{t('dismiss.description')}</p></div>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t('dismiss.placeholder')} />
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setDismissMode(false)}>{t('actions.cancel')}</Button><Button variant="destructive" disabled={busy || !reason.trim()} onClick={() => void mutate('dismiss')}>{t('actions.confirmDismiss')}</Button></div>
          </section>
        ) : null}

        <section className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
          <span className="text-xs text-slate-500">{t('feedback.wasHelpful')}</span>
          <div className="flex gap-2">
            <Button size="sm" variant={feedback === 'helpful' ? 'default' : 'outline'} onClick={() => void rate('helpful')}><ThumbsUp size={13} />{t('feedback.helpful')}</Button>
            <Button size="sm" variant={feedback === 'not_helpful' ? 'default' : 'outline'} onClick={() => void rate('not_helpful')}><ThumbsDown size={13} />{t('feedback.notHelpful')}</Button>
          </div>
        </section>
      </div>
    </UrlDrawer>
  )

  function FindingSummary({ item: finding }: { item: ContinuousCloseWorkItem }) {
    const s = finding.summary
    const rows: [string, string][] = []
    if (s.accountName) rows.push([t('fields.account'), [s.accountNumber, s.accountName].filter(Boolean).join(' · ')])
    if (s.count != null) rows.push([t('fields.count'), text(s.count)])
    if (s.oldestDate) rows.push([t('fields.oldestDate'), text(s.oldestDate)])
    if (s.throughDate) rows.push([t('fields.throughDate'), text(s.throughDate)])
    if (s.difference) rows.push([t('fields.difference'), money(text(s.difference))])
    if (s.scenarioName) rows.push([t('fields.budget'), text(s.scenarioName)])
    if (s.budget != null) rows.push([t('fields.budgetAmount'), money(text(s.budget))])
    if (s.actual != null) rows.push([t('fields.actual'), money(text(s.actual))])
    if (s.variance != null) rows.push([t('fields.variance'), money(text(s.variance))])
    if (s.currentPeriod) rows.push([t('fields.period'), `${text(s.currentPeriod)} / ${text(s.priorPeriod)}`])
    if (s.revenueChangeBps != null) rows.push([t('fields.revenueChange'), `${(Number(s.revenueChangeBps) / 100).toFixed(1)}%`])
    if (s.grossMarginDropBps != null) rows.push([t('fields.marginChange'), `${(Number(s.grossMarginDropBps) / 100).toFixed(1)} ${t('fields.points')}`])
    return <dl className="grid gap-x-4 gap-y-2 rounded-xl bg-slate-50 p-4 sm:grid-cols-2 dark:bg-slate-900">{rows.map(([label, value]) => <div key={label}><dt className="text-[11px] font-medium uppercase text-slate-500">{label}</dt><dd className="mt-0.5 text-sm font-medium tabular-nums">{value}</dd></div>)}</dl>
  }

  function EvidenceRow({ evidence }: { evidence: Evidence }) {
    const d = evidence.data
    let primary = t(`evidence.${evidence.kind}` as never)
    let secondary = ''
    let amount: string | null = null
    if (evidence.kind === 'bank_transaction') { primary = text(d.description); secondary = text(d.postedOn); amount = text(d.amount) }
    if (evidence.kind === 'document') { primary = text(d.documentNumber); secondary = `${text(d.kind)} · ${text(d.documentDate)}`; amount = text(d.total) }
    if (evidence.kind === 'reconciliation') { secondary = `${t('fields.throughDate')}: ${text(d.throughDate)}`; amount = text(d.difference) }
    if (evidence.kind === 'budget_variance') { secondary = `${t('fields.budgetAmount')}: ${money(text(d.budget))} · ${t('fields.actual')}: ${money(text(d.actual))}`; amount = text(d.variance) }
    if (evidence.kind === 'period_comparison') { secondary = `${text(d.currentPeriod)} / ${text(d.priorPeriod)}` }
    return <div className="flex items-center gap-3 px-3 py-2.5"><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{primary}</div>{secondary ? <div className="truncate text-xs text-slate-500">{secondary}</div> : null}</div>{amount ? <div className="shrink-0 text-right text-sm font-medium tabular-nums">{money(amount)}</div> : null}</div>
  }

  function AnalysisList({ title, values }: { title: string; values: unknown }) {
    if (!Array.isArray(values) || values.length === 0) return null
    const items = values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    if (!items.length) return null
    return <div><h4 className="text-xs font-semibold text-slate-800 dark:text-slate-200">{title}</h4><ul className="mt-1.5 list-disc space-y-1 pl-4 text-sm leading-5 text-slate-700 dark:text-slate-300">{items.map((value, index) => <li key={index}>{value}</li>)}</ul></div>
  }
}
