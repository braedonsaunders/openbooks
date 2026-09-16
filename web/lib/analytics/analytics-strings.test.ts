import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * Guard: no new hardcoded user-facing sentence strings in the analytics
 * loader layer (`web/lib/analytics/**` implementation files plus the hub
 * `view.ts` loaders).
 *
 * Every insight sentence template, month/period label and other display
 * string in these modules resolves through the message catalogs (the
 * `*-strings.ts` bundles, whose English defaults are the canonical source).
 * A Capitalized multi-word literal anywhere else in these files is either a
 * reviewed leftover below or a regression — the scan fails closed so a new
 * one trips this test.
 *
 * Pattern-based, with an identifier allowlist:
 * - single/double-quoted literals and interpolation-free template literals
 *   matching `^[A-Z].* [a-z]` (length >= 12) are display-sentence suspects.
 *   Interpolated templates are SQL/value composition, not display copy.
 *   Lowercase-start literals are error/code contracts, untouched by design.
 * - IDENTIFIER_ALLOWLIST names declarations whose string contents stay
 *   English: key registries the config API reads keys from (RATIO_DEFS
 *   precedent), the ANALYTICS_CONFIG API contract, data codes, units and
 *   formula text.
 * - LEGACY_ALLOWLIST pins exact leftover literals with their owner/reason.
 *   Localize one and delete its entry; add nothing without a reason.
 *
 * Hub client chrome (`.tsx` Views, `_ui`) follows the `useTranslations` /
 * `useLocale` convention enforced per-hub by source-scan tests (see
 * `cashflow/CashflowView.test.ts`); the shared `_ui` chrome is a separate
 * follow-up and is out of this guard's scope.
 */

const ANALYTICS_DIR = import.meta.dirname
const WEB_DIR = join(ANALYTICS_DIR, '..', '..')
const HUB_DIR = join(WEB_DIR, 'app', '(app)', 'analytics')

/** English-default homes and their tests never scan. */
const EXEMPT_BASENAMES = new Set(['catalog-strings.ts'])

/** identifier -> why its string contents stay English. */
const IDENTIFIER_ALLOWLIST: Record<string, string> = {
  RATIO_DEFS: 'static English ratio registry for out-of-scope surfaces (accounting home, widgets); dashboards read localizedRatioDefs()',
  ANALYTICS_CONFIG: 'config API contract: GET serves spec.fields labels/help; hub clients render catalog config.fields.* keys instead',
  ALLOCATION_BASES: 'static English rate-engine key registry; the config API reads keys only and the hub renders trueCost.bases.*',
  ALLOCATION_METHODS: 'same as ALLOCATION_BASES; descriptions are formula reference text',
  RATE_FORMATS: 'same as ALLOCATION_BASES; labels are unit reference text',
  COMPOSITE_METHODS: 'same as ALLOCATION_BASES',
}

/** Exact legacy literals outside identifier scope: { file, literal, reason }. */
const LEGACY_ALLOWLIST: Array<{ file: string; literal: string; reason: string }> = [
  {
    file: 'health-translated-statements.ts',
    literal: 'Accumulated earnings (computed)',
    reason: 'statement-layer computed line name; financial statements own their locale mechanism, not the insight bundles',
  },
  {
    file: 'health-translated-statements.ts',
    literal: 'Cumulative translation adjustment',
    reason: 'statement-layer computed line name; financial statements own their locale mechanism, not the insight bundles',
  },
]

interface Literal {
  line: number
  value: string
}

function isExemptFile(basename: string): boolean {
  return basename.endsWith('-strings.ts') || basename.endsWith('.test.ts') || EXEMPT_BASENAMES.has(basename)
}

/**
 * Minimal lexer: walks the source once, skipping line/block comments and
 * blanking string contents for the skeleton while recording every literal
 * with its start line. Template literals containing `${` are recorded with
 * their full text so callers can skip them (SQL/value composition).
 */
function lex(source: string): { literals: Literal[]; skeleton: string } {
  const literals: Literal[] = []
  const out: string[] = []
  let i = 0
  let line = 1
  const push = (text: string) => {
    for (const ch of text) {
      if (ch === '\n') { out.push('\n') } else { out.push(' ') }
    }
    line += text.split('\n').length - 1
  }
  while (i < source.length) {
    const ch = source[i]!
    if (ch === '\n') { line++; out.push('\n'); i++; continue }
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i)
      const comment = end === -1 ? source.slice(i) : source.slice(i, end)
      push(comment)
      i += comment.length
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const comment = end === -1 ? source.slice(i) : source.slice(i, end + 2)
      push(comment)
      i += comment.length
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const startLine = line
      let j = i + 1
      let closed = false
      while (j < source.length) {
        const c = source[j]!
        if (c === '\n' && ch !== '`') break
        if (c === '\\') { j += 2; continue }
        if (c === ch) { closed = true; break }
        j++
      }
      const raw = closed ? source.slice(i, j + 1) : source.slice(i, j)
      literals.push({ line: startLine, value: raw })
      push(raw)
      // recount lines consumed inside the literal for the skeleton cursor
      i += raw.length
      continue
    }
    out.push(ch)
    i++
  }
  return { literals, skeleton: out.join('') }
}

/** Display-sentence suspect: Capitalized, multi-word, long enough to say something. */
export function isSentenceSuspect(raw: string): boolean {
  const quote = raw[0]
  if (quote !== "'" && quote !== '"') {
    if (quote !== '`' || raw.includes('${')) return false
  }
  const value = raw.slice(1, raw.endsWith(quote!) && raw.length > 1 ? -1 : undefined)
  if (value.length < 12) return false
  if (!/^[A-Z]/.test(value)) return false
  return / [a-z]/.test(value)
}

/** Brace-match the `export const IDENT … = { … }` declaration; null when absent. */
function declarationRange(skeleton: string, identifier: string): [number, number] | null {
  // Anchor on the assignment brace — the type annotation may carry its own
  // braces (e.g. `Record<string, { … }>`), which must not start the range.
  const match = new RegExp(`export\\s+const\\s+${identifier}\\b[^=]*=\\s*\\{`).exec(skeleton)
  if (!match) return null
  const open = match.index + match[0].length - 1
  let depth = 0
  for (let i = open; i < skeleton.length; i++) {
    if (skeleton[i] === '{') depth++
    else if (skeleton[i] === '}') {
      depth--
      if (depth === 0) {
        const startLine = skeleton.slice(0, match.index).split('\n').length
        const endLine = skeleton.slice(0, i + 1).split('\n').length
        return [startLine, endLine]
      }
    }
  }
  return null
}

export interface Violation {
  file: string
  line: number
  literal: string
}

export function scanSource(relativeFile: string, source: string): Violation[] {
  const { literals, skeleton } = lex(source)
  const ranges = new Map<string, [number, number]>()
  for (const identifier of Object.keys(IDENTIFIER_ALLOWLIST)) {
    const range = declarationRange(skeleton, identifier)
    if (range) ranges.set(identifier, range)
  }
  const violations: Violation[] = []
  for (const literal of literals) {
    if (!isSentenceSuspect(literal.value)) continue
    let waived = false
    for (const [, [start, end]] of ranges) {
      if (literal.line >= start && literal.line <= end) { waived = true; break }
    }
    if (waived) continue
    const inner = literal.value.slice(1, -1)
    const legacy = LEGACY_ALLOWLIST.find((e) => e.file === relativeFile && e.literal === inner)
    if (legacy) continue
    violations.push({ file: relativeFile, line: literal.line, literal: inner.slice(0, 120) })
  }
  return violations
}

function inScopeFiles(): string[] {
  const files = readdirSync(ANALYTICS_DIR)
    .filter((name) => name.endsWith('.ts') && !isExemptFile(name))
    .map((name) => join(ANALYTICS_DIR, name))
  // Hub server loaders (explicit list — no client components).
  const loaders = [
    'cashflow', 'customer-intelligence', 'financial-health', 'sentinel',
    'spend-velocity', 'true-cost', 'utilization', 'vendor-performance',
  ].map((hub) => join(HUB_DIR, hub, 'view.ts'))
  loaders.push(join(HUB_DIR, 'true-cost', 'planner', 'view.ts'))
  return [...files, ...loaders]
}

test('no new hardcoded sentence strings in the analytics loader layer', () => {
  const violations: Violation[] = []
  for (const file of inScopeFiles()) {
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const relativeFile = file.startsWith(ANALYTICS_DIR) ? file.slice(ANALYTICS_DIR.length + 1) : file.slice(WEB_DIR.length + 1)
    violations.push(...scanSource(relativeFile, source))
  }
  assert.deepEqual(
    violations,
    [],
    `hardcoded display sentences must move to the message catalogs:\n${violations.map((v) => `  ${v.file}:${v.line}: ${JSON.stringify(v.literal)}`).join('\n')}`,
  )
})

test('the scanner flags display sentences and spares codes, SQL and units', () => {
  const flagged = scanSource(
    'probe.ts',
    [
      'insights.push({ type: "alert", title: "Revenue falling fast", message: "Revenue is down 40% vs prior year." })',
      'alerts.push({ type: "warning", reason: "Something broke badly here, look now" })',
      'const label = "Billable percentage point change"',
    ].join('\n'),
  ).map((v) => v.line)
  assert.deepEqual(flagged, [1, 1, 2, 3])
  const spared = scanSource(
    'probe.ts',
    [
      'const TIME_KEY = "nonbillable_time"',
      'export const OVERALL = "Overall"',
      'const unit = "hrs"',
      'const short = "Too short"',
      'const lower = "lowercase start stays"',
      'await db.execute(sql`select coalesce(p.display_name, \'Unknown\') as name from parties where org_id = ${orgId}`)',
      'const key = `${dept}|${month}`',
      'throw new Error("feature is disabled")',
    ].join('\n'),
  )
  assert.deepEqual(spared, [])
})
