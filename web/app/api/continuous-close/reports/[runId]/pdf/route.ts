import { NextResponse } from 'next/server'
import { getLocale, getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { resolvePdfPageSetup } from '@openbooks/pdf'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../../lib/authz'
import { readableContinuousCloseAgents } from '../../../../../../lib/continuous-close'
import { pdfResponse, safeName } from '../../../../../../lib/export'
import { exportDataToPdf, orgBranding, type ExportData } from '../../../../../../lib/report-pdf'
import { isUuid } from '../../../../../../lib/list-params'

export const runtime = 'nodejs'

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const gate = await guardPermission('assistant.use')
  if (gate instanceof NextResponse) return gate
  const { runId } = await params
  if (!isUuid(runId)) return NextResponse.json({ error: 'invalid_report' }, { status: 422 })
  const readable = readableContinuousCloseAgents(gate)
  if (!readable.length) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const result = (await db.execute<{ agent_key: 'accounting' | 'finance'; finished_at: Date; narrative: Record<string, unknown> }>(sql`
    select r.agent_key, r.finished_at, r.stats->'enrichment'->'narrative' as narrative
      from ai_agent_runs r
     where r.id = ${runId} and r.org_id = ${gate.user.orgId}
       and r.agent_key in (${sql.join(readable.map((agent) => sql`${agent}`), sql`, `)})
       and r.status = 'completed'
       and jsonb_typeof(r.stats->'enrichment'->'narrative') = 'object'
  `))
  const run = result.rows[0]
  if (!run) return NextResponse.json({ error: 'report_not_found' }, { status: 404 })

  const t = await getTranslations('continuousClose')
  const locale = await getLocale()
  const narrative = run.narrative
  const title = typeof narrative.title === 'string' ? narrative.title : t('narrative.title')
  const generated = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(run.finished_at))
  const groups: ExportData['groups'] = []
  const executiveSummary = typeof narrative.executiveSummary === 'string' ? narrative.executiveSummary : ''
  if (executiveSummary) groups.push(textGroup(t('narrative.executiveSummary'), [executiveSummary]))
  for (const [label, value] of [
    [t('narrative.highlights'), narrative.highlights],
    [t('narrative.risks'), narrative.risks],
    [t('narrative.recommendations'), narrative.recommendations],
  ] as const) {
    const items = strings(value)
    if (items.length) groups.push(textGroup(label, items))
  }
  for (const section of objects(narrative.sections)) {
    const sectionTitle = typeof section.title === 'string' ? section.title : ''
    const body = typeof section.body === 'string' ? section.body : ''
    if (sectionTitle && body) groups.push(textGroup(sectionTitle, [body]))
  }
  const citations = objects(narrative.citations).flatMap((citation) => {
    const label = typeof citation.label === 'string' ? citation.label : ''
    const href = typeof citation.href === 'string' && citation.href.startsWith('/') && !citation.href.startsWith('//') ? citation.href : ''
    return label && href ? [[label, href]] : []
  })
  if (citations.length) {
    groups.push({
      kind: 'section',
      title: t('narrative.sources'),
      columns: [t('narrative.sourceLabel'), t('narrative.sourcePath')],
      rows: citations,
      align: ['left', 'left'],
    })
  }
  const data: ExportData = {
    title,
    dateRangeLabel: typeof narrative.periodLabel === 'string' ? narrative.periodLabel : t('narrative.generated', { date: generated }),
    summary: [
      { label: t('table.agent'), value: t(`agents.${run.agent_key}`) },
      { label: t('narrative.generatedLabel'), value: generated },
    ],
    groups,
  }
  const branding = await orgBranding(gate.user.orgId)
  const layout = resolvePdfPageSetup({ paperSize: 'letter', orientation: 'portrait', marginMm: 16, density: 'standard' })
  const pdf = await exportDataToPdf(data, branding, layout, { showSummary: true })
  return pdfResponse(pdf, safeName(`${title}-${runId.slice(0, 8)}`))
}

function textGroup(title: string, values: string[]): ExportData['groups'][number] {
  return { kind: 'section', title, columns: [''], rows: values.map((value) => [value]), align: ['left'] }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    : []
}
