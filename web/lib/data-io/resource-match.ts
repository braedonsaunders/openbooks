import type { ResourceField } from './types'

/**
 * Match a staged file's headers against import resources. Pure and
 * client-safe. The match is a starting point for the operator (or the
 * migration assistant) to confirm: it only pairs headers whose normalized
 * text equals a field key or label, so it never invents a mapping from a
 * loose resemblance.
 */

export const normalizeHeader = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

export interface ResourceCandidate {
  key: string
  label: string
  group: string
  fields: ResourceField[]
}

export interface ResourceMatch {
  resource: string
  label: string
  group: string
  /** Header → field key, for headers that match a field key or label exactly. */
  mapping: Record<string, string>
  matchedHeaders: number
  requiredFields: number
  requiredMatched: number
  /** Required editable fields no header supplies, by key. */
  missingRequired: string[]
  /** 0..1: share of headers placed, discounted by missing required fields. */
  score: number
}

export function matchHeadersToFields(headers: readonly string[], fields: readonly ResourceField[]): Record<string, string> {
  const editable = fields.filter((field) => !field.readOnly)
  const byText = new Map<string, string>()
  for (const field of editable) {
    for (const text of [field.key, field.label]) {
      const normalized = normalizeHeader(text)
      if (normalized && !byText.has(normalized)) byText.set(normalized, field.key)
    }
  }
  const mapping: Record<string, string> = {}
  const used = new Set<string>()
  for (const header of headers) {
    const target = byText.get(normalizeHeader(header))
    if (target && !used.has(target)) {
      mapping[header] = target
      used.add(target)
    }
  }
  return mapping
}

export function rankResources(headers: readonly string[], candidates: readonly ResourceCandidate[], limit = 5): ResourceMatch[] {
  const meaningful = headers.filter((header) => normalizeHeader(header) !== '')
  if (meaningful.length === 0) return []
  const matches = candidates.map((candidate): ResourceMatch => {
    const mapping = matchHeadersToFields(meaningful, candidate.fields)
    const mapped = new Set(Object.values(mapping))
    const required = candidate.fields.filter((field) => field.required && !field.readOnly)
    const missingRequired = required.filter((field) => !mapped.has(field.key)).map((field) => field.key)
    const matchedHeaders = Object.keys(mapping).length
    const coverage = matchedHeaders / meaningful.length
    const requiredShare = required.length ? (required.length - missingRequired.length) / required.length : 1
    return {
      resource: candidate.key,
      label: candidate.label,
      group: candidate.group,
      mapping,
      matchedHeaders,
      requiredFields: required.length,
      requiredMatched: required.length - missingRequired.length,
      missingRequired,
      score: Math.round(coverage * requiredShare * 1000) / 1000,
    }
  })
  return matches
    .filter((match) => match.matchedHeaders > 0)
    .sort((a, b) => b.score - a.score || b.matchedHeaders - a.matchedHeaders || a.resource.localeCompare(b.resource))
    .slice(0, limit)
}

const FILENAME_HINTS: { pattern: RegExp; resource: string }[] = [
  { pattern: /receivables?|invoices?|open.?ar\b/, resource: 'txn:customer_invoice' },
  { pattern: /payables?|bills?|open.?ap\b/, resource: 'txn:vendor_bill' },
  { pattern: /fixed.?assets?|asset.?register/, resource: 'fixed-assets' },
  { pattern: /items?|products?|services?|sku/, resource: 'items' },
  { pattern: /customers?|clients?|vendors?|suppliers?|contacts?|part(y|ies)|employees?/, resource: 'parties' },
  { pattern: /chart.?of.?accounts|\bcoa\b|\baccounts?\b/, resource: 'accounts' },
]

/**
 * A provisional resource for a file dropped before its content is known,
 * from its name only. The staged file is re-targeted once its headers are
 * read, so this choice is never final; it falls back to the first
 * importable resource offered.
 */
export function provisionalResourceForFile(filename: string, importable: readonly string[]): string | null {
  const name = filename.toLowerCase().replace(/\.[a-z0-9]+$/, '')
  for (const hint of FILENAME_HINTS) {
    if (hint.pattern.test(name) && importable.includes(hint.resource)) return hint.resource
  }
  return importable[0] ?? null
}
