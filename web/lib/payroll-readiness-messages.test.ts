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
  import.meta.dirname, '..', '..', 'engine', 'src', 'payroll-readiness.ts',
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
