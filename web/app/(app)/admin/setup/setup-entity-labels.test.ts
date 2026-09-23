import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { SETUP_ENTITY_BY_KEY } from '../../../../lib/setup/registry'

/**
 * F5: /admin/setup rendered the raw keys
 * admin.setup.entities.hrm-pipeline-templates.title and
 * admin.setup.entities.hrm-pipeline-stages.title with MISSING_MESSAGE in
 * the console — the registry gained two entities no locale defined.
 *
 * Derived from the registry, never a hand list: every entity the Setup
 * workspace itself renders (not rehomed, not nested) must have
 * entities.<key>.title and .description in every locale. Rehomed and
 * nested entities render under their own surfaces with their own copy, so
 * they are out of scope here.
 */

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const

function entitiesOf(locale: string): Record<string, { title?: unknown; description?: unknown }> {
  const catalog = JSON.parse(readFileSync(join(process.cwd(), 'web', 'messages', locale, 'admin.json'), 'utf8'))
  return catalog.setup.entities as Record<string, { title?: unknown; description?: unknown }>
}

const visible = [...SETUP_ENTITY_BY_KEY.values()].filter((entity) => !entity.rehomed && !entity.nestedUnder)

test('every Setup-rendered registry entity has a title in every locale', () => {
  const violations: string[] = []
  for (const locale of LOCALES) {
    const entities = entitiesOf(locale)
    for (const entity of visible) {
      const title = entities[entity.key]?.title
      if (typeof title !== 'string' || title.length === 0) {
        violations.push(`${locale}: entities.${entity.key}.title is missing (renders as a raw key in the nav)`)
      }
    }
  }
  assert.deepEqual(violations, [], `Setup entities without a nav title:\n${violations.join('\n')}`)
})

test('every Setup-rendered registry entity has a description in every locale', () => {
  const violations: string[] = []
  for (const locale of LOCALES) {
    const entities = entitiesOf(locale)
    for (const entity of visible) {
      const description = entities[entity.key]?.description
      if (typeof description !== 'string' || description.length === 0) {
        violations.push(`${locale}: entities.${entity.key}.description is missing`)
      }
    }
  }
  assert.deepEqual(violations, [], `Setup entities without a description:\n${violations.join('\n')}`)
})

test('the pipeline entities render named titles, never raw keys', () => {
  for (const key of ['hrm-pipeline-templates', 'hrm-pipeline-stages'] as const) {
    const entity = SETUP_ENTITY_BY_KEY.get(key)
    assert.ok(entity && !entity.rehomed && !entity.nestedUnder, `${key} renders in the Setup workspace`)
    for (const locale of LOCALES) {
      const title = entitiesOf(locale)[key]?.title
      assert.ok(typeof title === 'string' && !title.includes(key), `${locale}: ${key} has a human title`)
    }
  }
})
