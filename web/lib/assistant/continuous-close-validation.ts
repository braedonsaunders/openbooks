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

const DECIMAL_AMOUNT = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/

/** Keep ledger decimal strings exact until Intl performs display rounding. */
function decimalText(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return DECIMAL_AMOUNT.test(trimmed) ? trimmed : null
}

function formattedAmount(value: unknown, locale: string, useGrouping: boolean): string | null {
  const raw = decimalText(value)
  if (raw === null) return null
  const absolute = raw.replace(/^[+-]/, '')
  try {
    const formatted = new Intl.NumberFormat(locale, {
      useGrouping,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(absolute as never)
    // Intl renders out-of-range exponent values as infinity; those are not
    // finite ledger totals and must remain invalid rather than matching text.
    return formatted.includes('∞') ? null : formatted
  } catch {
    return null
  }
}

function containsExactAmount(text: string, value: unknown): boolean {
  const candidates = [
    formattedAmount(value, 'en-CA', false),
    formattedAmount(value, 'en-CA', true),
    formattedAmount(value, 'fr-CA', true),
  ]
  return candidates.some((candidate) => candidate !== null && text.includes(candidate))
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
    const total = totals?.total
    const expectedHref = requiredDate ? `/reports/aging?side=${side}&asOf=${requiredDate}` : null
    if (!expectedHref || !narrative.citations.some((citation) => citation.href === expectedHref)) {
      issues.push(`missing_current_${side}_citation`)
    }
    if (!containsExactAmount(text, total)) {
      issues.push(`missing_exact_${side}_total`)
    }
    const wrongAgingCitation = narrative.citations.find((citation) =>
      citation.href.startsWith(`/reports/aging?side=${side}&`) && citation.href !== expectedHref)
    if (wrongAgingCitation) issues.push(`wrong_${side}_aging_date`)
  }
  return [...new Set(issues)]
}
