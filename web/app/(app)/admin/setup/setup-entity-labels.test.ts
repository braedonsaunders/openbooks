import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { SETUP_ENTITY_BY_KEY } from '../../../../lib/setup/registry'

/**
 * F5 + follow-up: /admin/setup rendered raw keys for entities the registry
 * knew but no locale defined (hrm-pipeline-templates, hrm-pipeline-stages,
 * then ai-rails-settings on /admin/ai). The first version of this test only
 * covered nav-visible entities, so the rehomed ai-rails-settings slipped
 * through: it never rides the nav, but the shared setup-section widget
 * mounts it on the AI page and resolves the same entities.<key>.title.
 *
 * Derived from the tree, never a hand list: the required set is every
 * registry entity mounted on a Setup surface — nav-visible ones plus every
 * key the setup-section widget or a direct SetupEntitySection slot mounts,
 * with _ENTITY.key constants resolved through their defining modules.
 * Entities with no Setup mount at all (bespoke surfaces with their own
 * labels) must match the proven-bespoke set, so a newly unmounted entity
 * forces a conscious decision instead of silently skipping coverage.
 */

const ROOT = process.cwd()
const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out)
    } else if ((path.endsWith('.ts') || path.endsWith('.tsx')) && !path.endsWith('.test.ts')) {
      out.push(path)
    }
  }
  return out
}

/** Every registry key mounted on a Setup surface, derived from the sources. */
function mountedKeys(): Set<string> {
  const mounted = new Set<string>()
  for (const entity of SETUP_ENTITY_BY_KEY.values()) {
    if (!entity.rehomed && !entity.nestedUnder) mounted.add(entity.key)
  }
  const trees = [join(ROOT, 'web', 'app'), join(ROOT, 'web', 'components')].flatMap((dir) => sourceFiles(dir))
  for (const file of trees) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/entityKey:\s*'([^']+)'/g)) mounted.add(match[1]!)
    for (const match of source.matchAll(/SETUP_ENTITY_BY_KEY\.get\('([^']+)'\)/g)) mounted.add(match[1]!)
    for (const match of source.matchAll(/\b([A-Z][A-Z0-9]*_ENTITY)\.key\b/g)) {
      const name = match[1]!
      const from = source.match(new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'([^']+)'`))
      assert.ok(from, `${file}: cannot trace ${name} to its defining module`)
      const defining = resolve(dirname(file), from[1]!)
      const candidates = [defining, `${defining}.ts`, `${defining}.tsx`]
      const found = candidates.find((candidate) => existsSync(candidate))
      assert.ok(found, `${file}: defining module for ${name} not found`)
      const key = readFileSync(found, 'utf8').match(new RegExp(`${name.replace(/[A-Z_]+/, '[A-Z_]+')}\\s*=\\s*\\{[^}]*key:\\s*'([^']+)'`, 's'))
        ?? readFileSync(found, 'utf8').match(/key:\s*'([^']+)'/)
      assert.ok(key, `${file}: no key literal for ${name} in ${found}`)
      mounted.add(key[1]!)
    }
  }
  // The [entity] page itself renders SetupEntitySection for any key the URL
  // names, so nav reachability is already covered above; nothing to add.
  return mounted
}

function entitiesOf(locale: string): Record<string, { title?: unknown; description?: unknown }> {
  const catalog = JSON.parse(readFileSync(join(ROOT, 'web', 'messages', locale, 'admin.json'), 'utf8'))
  return catalog.setup.entities as Record<string, { title?: unknown; description?: unknown }>
}

test('every Setup-mounted registry entity has a title in every locale', () => {
  const violations: string[] = []
  for (const locale of LOCALES) {
    const entities = entitiesOf(locale)
    for (const key of [...mountedKeys()].sort()) {
      const title = entities[key]?.title
      if (typeof title !== 'string' || title.length === 0) {
        violations.push(`${locale}: entities.${key}.title is missing (renders as a raw key)`)
      }
    }
  }
  assert.deepEqual(violations, [], `Setup surfaces without a title:\n${violations.join('\n')}`)
})

test('every Setup-mounted registry entity has a description in every locale', () => {
  const violations: string[] = []
  for (const locale of LOCALES) {
    const entities = entitiesOf(locale)
    for (const key of [...mountedKeys()].sort()) {
      const description = entities[key]?.description
      if (typeof description !== 'string' || description.length === 0) {
        violations.push(`${locale}: entities.${key}.description is missing`)
      }
    }
  }
  assert.deepEqual(violations, [], `Setup surfaces without a description:\n${violations.join('\n')}`)
})

test('every Setup mount names a real registry entity', () => {
  // SetupSectionSlot returns null for an unknown key: a renamed entity
  // would silently empty its surface instead of failing loudly.
  const mounted = mountedKeys()
  for (const key of [...mounted].sort()) {
    assert.ok(SETUP_ENTITY_BY_KEY.has(key), `Setup surface mounts unknown entity '${key}'`)
  }
})

test('the six keys that shipped without labels stay covered', () => {
  // hrm-pipeline-templates/stages (F5), ai-rails-settings (follow-up),
  // hrm-action-reasons and qualification-types/settings (same prod-log
  // class): each rendered through a Setup surface with no locale copy.
  // If any of them ever leaves the mounted set, its surface stopped
  // resolving admin.setup labels — say so explicitly, never silently.
  const mounted = mountedKeys()
  for (const key of [
    'hrm-pipeline-templates',
    'hrm-pipeline-stages',
    'ai-rails-settings',
    'hrm-action-reasons',
    'qualification-types',
    'qualification-settings',
  ]) {
    assert.ok(mounted.has(key), `${key} must stay in the label-covered set`)
  }
})
