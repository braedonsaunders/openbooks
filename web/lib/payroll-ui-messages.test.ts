import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'

/**
 * Every literal message key a payroll screen asks for must exist.
 *
 * This is the third guard against the same silent failure, and it exists
 * because the first two were too narrow. `report-catalog-messages` covers
 * report columns and `payroll-readiness-messages` covers readiness codes, so
 * when a whole settings tab shipped with an unfolded message block, nothing
 * failed — the screen simply rendered `payroll.workSchedules.title` and the
 * suite stayed green. next-intl returns the key path instead of throwing, so
 * the only way to catch this is to check the keys against the catalog.
 *
 * Only STATIC `t('a.b')` calls are checked. A dynamic `t(`scope.${x}`)` cannot
 * be resolved from source without evaluating it, so those stay the owning
 * test's job — but a component is usually mostly static, and the failure this
 * catches is a whole namespace missing, not one branch of one template.
 */

const WEB = join(import.meta.dirname, '..')

/** Payroll's own screens — the surface this guard is responsible for. */
const ROOTS = [
  join(WEB, 'app', '(app)', 'payroll'),
  join(WEB, 'app', '(app)', 'admin', 'setup', 'payroll'),
]

function walk(dir: string): string[] {
  let out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out = out.concat(walk(full))
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full)
  }
  return out
}

const catalogs = new Map<string, unknown>()
function catalog(namespace: string): unknown {
  const file = namespace.split('.')[0]!
  if (!catalogs.has(file)) {
    try {
      catalogs.set(file, JSON.parse(readFileSync(join(WEB, 'messages', 'en', `${file}.json`), 'utf8')))
    } catch {
      catalogs.set(file, undefined)
    }
  }
  return catalogs.get(file)
}

/** Resolve `payroll.workSchedules.title` the way next-intl does — by nesting. */
function resolve(path: string): unknown {
  let node = catalog(path)
  // The first segment names the catalog FILE, and is not a key inside it.
  for (const segment of path.split('.').slice(1)) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

test('every literal message key a payroll screen asks for exists', () => {
  const files = ROOTS.flatMap(walk)
  assert.ok(files.length > 10, `only ${files.length} payroll screens found — the scan broke`)

  const missing: string[] = []
  let checked = 0
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    // The namespace a component binds, e.g. useTranslations('payroll.workSchedules').
    for (const bind of source.matchAll(
      /(?:useTranslations|getTranslations)\(\s*['"]([\w.]+)['"]\s*\)/g,
    )) {
      const namespace = bind[1]!
      // `t.has(k) ? t(k) : 'English'` is the codebase's deliberate transitional
      // pattern — the key is optional and the screen reads correctly without
      // it. Those are not breakage, so a key guarded anywhere in the file is
      // exempt. Everything else renders its own key path when absent.
      const guarded = new Set(
        [...source.matchAll(/t\.has\(\s*'([\w.]+)'/g)].map((m) => m[1]!),
      )
      for (const call of source.matchAll(/\bt\(\s*'([\w.]+)'/g)) {
        if (guarded.has(call[1]!)) continue
        checked += 1
        const full = `${namespace}.${call[1]!}`
        if (typeof resolve(full) !== 'string') {
          missing.push(`${relative(WEB, file)}: ${full}`)
        }
      }
      break // one namespace per file is the pattern here; `tc` etc. are separate binds
    }
  }

  assert.ok(checked > 50, `only ${checked} keys checked — the scan matched too little`)
  assert.deepEqual(
    [...new Set(missing)].sort(),
    [],
    `these render as raw key paths on a payroll screen:\n${[...new Set(missing)].sort().join('\n')}`,
  )
})
