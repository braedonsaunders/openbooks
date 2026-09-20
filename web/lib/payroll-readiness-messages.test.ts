import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * Every readiness code the payroll engine can emit must have a message.
 *
 * The run wizard renders `payroll.wizard.readiness.codes.<code>`; a code with
 * no message renders its own key path on the one screen that decides whether a
 * payday is safe to run. That screen used to carry a hand-maintained map of
 * English fallbacks, which meant the gap was survivable but invisible — the
 * fallback drifted from the real message, and one of them still described the
 * shortfall in Canadian terms ("CPP/EI") on a country-agnostic screen.
 *
 * The map is gone, so this test is what keeps the promise instead. It reads the
 * engine source rather than importing it because the codes are string literals
 * at the `flag(...)` call sites, and a test that imported the module would need
 * a database.
 */

const READINESS = join(
  import.meta.dirname, '..', '..', 'engine', 'src', 'payroll', 'readiness.ts',
)
const MESSAGES = join(import.meta.dirname, '..', 'messages', 'en', 'payroll.json')

/** Codes passed to `flag("blocker" | "warning", "<code>", …)`, newlines allowed. */
function emittedCodes(source: string): string[] {
  const codes = new Set<string>()
  for (const match of source.matchAll(
    /flag\(\s*["'](?:blocker|warning)["']\s*,\s*["']([a-zA-Z][\w.]*)["']/g,
  )) {
    codes.add(match[1]!)
  }
  return [...codes].sort()
}

function messageAt(catalog: Record<string, unknown>, code: string): unknown {
  // next-intl resolves a dotted key by NESTING, which is exactly how the wizard
  // looks these up, so resolve them the same way here.
  let node: unknown = catalog
  for (const segment of ['wizard', 'readiness', 'codes', ...code.split('.')]) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

/**
 * The readiness screen is country-agnostic: the same run can pay Canadians
 * and Americans, and an org may only have one pack installed. A message that
 * names one country's programs (F-t08-004: a US-only org warned about
 * Canadian CPP/EI ceilings) is wrong for everyone on the other side, so no
 * readiness message may name a country-specific program or agency. Wording
 * must stay neutral ("annual statutory ceilings") and leave the specifics
 * to the linked fix screen.
 */
const COUNTRY_PROGRAM = /\b(CPP2?|QPP|QPIP|EI|FICA|FUTA|SUTA|TD1|T4127|T4|W-2|W-4|401\(k\)|ROE|CRA|IRS)\b/

function allMessages(node: unknown, path: string, out: Array<{ path: string; text: string }>): void {
  if (typeof node === 'string') {
    out.push({ path, text: node })
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      allMessages(value, path ? `${path}.${key}` : key, out)
    }
  }
}

test('no readiness message names a country-specific payroll program', () => {
  const catalog = JSON.parse(readFileSync(MESSAGES, 'utf8')) as Record<string, unknown>
  const found: Array<{ path: string; text: string }> = []
  allMessages((catalog as { wizard?: unknown }).wizard, 'wizard', found)
  const codes = found.filter((entry) => entry.path.startsWith('wizard.readiness.codes.'))
  assert.ok(codes.length >= 15, `only ${codes.length} readiness messages were found — the scan broke`)
  const offending = codes.filter((entry) => COUNTRY_PROGRAM.test(entry.text))
  assert.deepEqual(
    offending.map((entry) => entry.path),
    [],
    'these readiness messages name a country-specific program on a country-agnostic screen:\n'
      + offending.map((entry) => `  payroll.${entry.path}: ${entry.text}`).join('\n'),
  )
})

/**
 * The readiness panel promises every item links to where it is fixed
 * (F-t08-005: the period blocker stranded the user with plain text), so the
 * period blockers must carry the periods setup href — and it must be the
 * live screen, not the dead /admin/close route period.closed once used.
 */
test('period blockers resolve to the periods setup screen that can fix them', () => {
  const source = readFileSync(READINESS, 'utf8')
  for (const code of ['period.missing', 'period.closed']) {
    const at = source.indexOf(`"${code}"`)
    assert.ok(at >= 0, `the engine no longer emits ${code} — update this test`)
    const call = source.slice(at, at + 400)
    assert.match(
      call,
      /href: ['"]\/admin\/setup\/period-close['"]/,
      `${code} must link to the periods setup screen`,
    )
    assert.ok(!call.includes('/admin/close'), `${code} must not link to the dead /admin/close route`)
  }
  assert.ok(
    !/href: ['"]\/admin\/close['"]/.test(source),
    'no readiness flag may link to the dead /admin/close route',
  )
})

test('every readiness code the engine emits has a message', () => {
  const codes = emittedCodes(readFileSync(READINESS, 'utf8'))
  // A scan that silently matched nothing would pass this file vacuously.
  assert.ok(codes.length >= 15, `only ${codes.length} readiness codes were found — the scan broke`)
  assert.ok(codes.includes('employee.noWage'), 'the scan missed a known code')

  const catalog = JSON.parse(readFileSync(MESSAGES, 'utf8')) as Record<string, unknown>
  const missing = codes.filter((code) => typeof messageAt(catalog, code) !== 'string')
  assert.deepEqual(
    missing,
    [],
    'these readiness codes would render as raw key paths in the run wizard:\n'
      + missing.map((code) => `  payroll.wizard.readiness.codes.${code}`).join('\n'),
  )
})
