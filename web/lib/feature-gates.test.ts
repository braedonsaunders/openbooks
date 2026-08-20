import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

/**
 * The feature registry states a contract: "a feature that's off disappears from
 * nav, its routes 404, and its setup surfaces hide." AGENTS.md restates it as a
 * rule — feature dependencies are enforced at the domain/service and API
 * boundaries, "not only by hiding UI".
 *
 * Nav hiding is the easy half and the half that gets written. Equipment,
 * Expenses and Budgets each declared `navModules` and shipped with NO
 * server-side gate at all: turning them off removed the menu entry while the
 * page still rendered and its APIs still accepted writes.
 *
 * This test holds the other half. A feature that hides nav must also be
 * enforced somewhere on the server — via `requireFeatureEnabled`/`guardFeaturePermission`, a
 * bespoke gate (`projects-gate.ts`), or a direct `isFeatureEnabled` check.
 */

/**
 * The registry, read as source. `features.ts` is `server-only`, which throws
 * outside a Next render, so importing FEATURES here is not an option.
 */
function featuresDeclaringNav(): string[] {
  const source = readFileSync(new URL('./features.ts', import.meta.url), 'utf8')
  const list = source.slice(
    source.indexOf('export const FEATURES'),
    source.indexOf('\n]', source.indexOf('export const FEATURES')),
  )
  const keys: string[] = []
  for (const entry of list.matchAll(/\{ key: '([A-Za-z]+)'[^}]*\}/g)) {
    if (entry[0].includes('navModules:')) keys.push(entry[1])
  }
  assert.ok(keys.length > 0, 'could not parse the feature registry')
  return keys
}

/** Every feature key named in a server-side gate call anywhere under web/. */
function gatedFeatureKeys(): Set<string> {
  // Walk the source tree rather than shelling out to `git grep`: an untracked
  // new layout.tsx is still a real gate, and this must not depend on the file
  // having been staged.
  const keys = new Set<string>()
  const call =
    /(?:requireFeatureEnabled|guardFeaturePermission|isFeatureEnabled|featureEnabled)\([^)]*?'([A-Za-z]+)'/g
  const root = new URL('../', import.meta.url)
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue
      const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir)
      if (entry.isDirectory()) walk(child)
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        for (const match of readFileSync(child, 'utf8').matchAll(call)) keys.add(match[1])
      }
    }
  }
  walk(new URL('app/', root))
  walk(new URL('lib/', root))
  return keys
}

/**
 * Features deliberately without their own server gate, with the reason. Adding
 * to this list is a decision that should be argued for in review, which is the
 * point of making it explicit rather than letting silence pass.
 */
const UNGATED_BY_DESIGN: Record<string, string> = {
  // Banking's surfaces are gated per-capability (bankFeeds, imports); the parent
  // key only groups the nav modules.
  banking: 'nav grouping only — capabilities gate individually (bankFeeds)',
}

test('every feature that hides nav is also enforced on the server', () => {
  const gated = gatedFeatureKeys()
  const missing = featuresDeclaringNav().filter(
    (key) => !gated.has(key) && !(key in UNGATED_BY_DESIGN),
  )

  assert.deepEqual(
    missing,
    [],
    `these features hide nav but have no server-side gate, so "off" is cosmetic — ` +
      `their pages still render and their APIs still accept writes: ${missing.join(', ')}. ` +
      'Add requireFeatureEnabled() to the page and guardFeaturePermission() to each API handler.',
  )
})

test('the three modules this test was written for are gated', () => {
  // Pinned by name: a future refactor of the scan above must not quietly stop
  // covering the cases that motivated it.
  const gated = gatedFeatureKeys()
  for (const key of ['equipment', 'expenses', 'budgets']) {
    assert.ok(gated.has(key), `${key} lost its server-side feature gate`)
  }
})
