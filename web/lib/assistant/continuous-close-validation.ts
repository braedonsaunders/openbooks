type Citation = { label: string; href: string }

export type NarrativeForValidation = {
  title: string
  executiveSummary: string
  highlights: string[]
  risks: string[]
  recommendations: string[]
  sections: { title: string; body: string }[]
  citations: Citation[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function collectHrefs(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectHrefs(item, output)
    return output
  }
  const row = record(value)
  if (!row) return output
  for (const [key, child] of Object.entries(row)) {
    if (key === 'href' && typeof child === 'string' && child.startsWith('/') && !child.startsWith('//')) {
      output.add(child)
    } else {
      collectHrefs(child, output)
    }
  }
  return output
}

function narrativeText(narrative: NarrativeForValidation): string {
  return [
    narrative.title,
    narrative.executiveSummary,
    ...narrative.highlights,
    ...narrative.risks,
    ...narrative.recommendations,
    ...narrative.sections.flatMap((section) => [section.title, section.body]),
  ].join('\n')
}

function containsExactAmount(text: string, value: number): boolean {
  const fixed = Math.abs(value).toFixed(2)
  const english = Math.abs(value).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const french = Math.abs(value).toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return text.includes(fixed) || text.includes(english) || text.includes(french)
}

/** Fail-closed checks for the core facts that previously produced misleading reports. */
export function validateFinanceNarrative(
  narrative: NarrativeForValidation,
  evidence: Record<string, unknown>,
): string[] {
  const issues: string[] = []
  if (!narrative.title.trim()) issues.push('missing_title')
  if (!narrative.executiveSummary.trim()) issues.push('missing_executive_summary')

  const allowedHrefs = collectHrefs(evidence)
  for (const citation of narrative.citations) {
    if (!allowedHrefs.has(citation.href)) issues.push(`unsupported_citation:${citation.href}`)
  }

  const requiredDate = typeof evidence.requiredCurrentAgingDate === 'string'
    ? evidence.requiredCurrentAgingDate
    : null
  const text = narrativeText(narrative)
  for (const side of ['ar', 'ap'] as const) {
    const aging = record(evidence[`aging_${side}_current`])
    const totals = record(aging?.totals)
    const total = Number(totals?.total)
    const expectedHref = requiredDate ? `/reports/aging?side=${side}&asOf=${requiredDate}` : null
    if (!expectedHref || !narrative.citations.some((citation) => citation.href === expectedHref)) {
      issues.push(`missing_current_${side}_citation`)
    }
    if (!Number.isFinite(total) || !containsExactAmount(text, total)) {
      issues.push(`missing_exact_${side}_total`)
    }
    const wrongAgingCitation = narrative.citations.find((citation) =>
      citation.href.startsWith(`/reports/aging?side=${side}&`) && citation.href !== expectedHref)
    if (wrongAgingCitation) issues.push(`wrong_${side}_aging_date`)
  }
  return [...new Set(issues)]
}
