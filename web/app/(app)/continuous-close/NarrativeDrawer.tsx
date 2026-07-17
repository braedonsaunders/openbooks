'use client'

import Link from 'next/link'
import { Download, ExternalLink, Sparkles } from 'lucide-react'
import { Badge, Button, UrlDrawer } from '@openbooks/ui'

type NarrativeLabels = {
  agent: string
  generated: string
  executiveSummary: string
  highlights: string
  risks: string
  recommendations: string
  downloadPdf: string
  sources: string
}

export function NarrativeDrawer({
  runId,
  title,
  narrative,
  closeHref,
  labels,
}: {
  runId: string
  title: string
  narrative: Record<string, unknown>
  closeHref: string
  labels: NarrativeLabels
}) {
  const executiveSummary = typeof narrative.executiveSummary === 'string' ? narrative.executiveSummary : ''
  const sections = objects(narrative.sections)
  const citations = objects(narrative.citations)
  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="xl"
      title={title}
      description={labels.generated}
      headerActions={
        <Button variant="outline" size="sm" asChild>
          <a href={`/api/continuous-close/reports/${runId}/pdf`}>
            <Download size={14} />
            {labels.downloadPdf}
          </a>
        </Button>
      }
      bodyClassName="app-scroll min-h-0 flex-1 overflow-y-auto px-6 py-5"
    >
      <article className="mx-auto max-w-4xl space-y-6 pb-8">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-violet-600 dark:text-violet-400" />
          <Badge variant="outline">{labels.agent}</Badge>
        </div>
        {executiveSummary ? <NarrativeSection title={labels.executiveSummary} paragraphs={[executiveSummary]} /> : null}
        <NarrativeList title={labels.highlights} values={strings(narrative.highlights)} />
        <NarrativeList title={labels.risks} values={strings(narrative.risks)} tone="risk" />
        <NarrativeList title={labels.recommendations} values={strings(narrative.recommendations)} />
        {sections.map((section, index) => {
          const sectionTitle = typeof section.title === 'string' ? section.title : ''
          const body = typeof section.body === 'string' ? section.body : ''
          return sectionTitle && body ? <NarrativeSection key={`${sectionTitle}-${index}`} title={sectionTitle} paragraphs={[body]} /> : null
        })}
        {citations.length ? (
          <section className="space-y-3 border-t border-slate-200 pt-5 dark:border-slate-800">
            <h3 className="text-sm font-semibold">{labels.sources}</h3>
            <div className="flex flex-wrap gap-2">
              {citations.map((citation, index) => {
                const href = typeof citation.href === 'string' ? citation.href : ''
                const label = typeof citation.label === 'string' ? citation.label : ''
                if (!href.startsWith('/') || href.startsWith('//') || !label) return null
                return <Button key={`${href}-${index}`} variant="outline" size="sm" asChild><Link href={href as never}>{label}<ExternalLink size={12} /></Link></Button>
              })}
            </div>
          </section>
        ) : null}
      </article>
    </UrlDrawer>
  )
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    : []
}

function NarrativeSection({ title, paragraphs }: { title: string; paragraphs: string[] }) {
  return <section className="space-y-2"><h3 className="text-sm font-semibold text-slate-950 dark:text-slate-50">{title}</h3>{paragraphs.map((paragraph, index) => <p key={index} className="text-sm leading-7 text-slate-700 dark:text-slate-300">{paragraph}</p>)}</section>
}

function NarrativeList({ title, values, tone }: { title: string; values: string[]; tone?: 'risk' }) {
  if (!values.length) return null
  return <section className={`rounded-xl border p-4 ${tone === 'risk' ? 'border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20' : 'border-slate-200 dark:border-slate-800'}`}><h3 className="text-sm font-semibold">{title}</h3><ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-700 dark:text-slate-300">{values.map((value, index) => <li key={index}>{value}</li>)}</ul></section>
}
