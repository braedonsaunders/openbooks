import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { displayRoleName, SEEDED_ROLE_NAMES } from './role-display.ts'

const here = dirname(fileURLToPath(import.meta.url))
const messagesDir = join(here, '..', 'messages')
const catalog = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(messagesDir, locale, 'agents.json'), 'utf8'))

// F-t11-010(a): the finding drawer's Team select rendered DB-seeded English
// role names ("Accountant … Viewer") under fr/es. Unrenamed seed roles
// render via the catalog; a renamed (custom) role keeps its stored name.
test('seeded role names resolve through the translator', () => {
  const t = (key: string) => `<${key}>`
  assert.equal(displayRoleName('Accountant', t), '<accountant>')
  assert.equal(displayRoleName('Sales Representative', t), '<salesRepresentative>')
  assert.equal(displayRoleName('Équipe personnalisée', t), 'Équipe personnalisée')
})

for (const locale of ['en', 'fr', 'es']) {
  test(`F-t11-010: team role names are translated in ${locale}`, () => {
    const assignment = (catalog(locale).drawer as Record<string, unknown>).assignment as
      | Record<string, unknown>
      | undefined
    assert.ok(assignment, `${locale} drawer.assignment must exist`)
    const roles = assignment.roles as Record<string, unknown> | undefined
    assert.ok(roles, `${locale} drawer.assignment.roles must exist`)
    for (const key of Object.values(SEEDED_ROLE_NAMES)) {
      assert.equal(typeof roles[key], 'string', `${locale} roles.${key} must be translated`)
    }
  })
}

test('the seeded-name map matches the engine built-in roles', () => {
  const seed = readFileSync(join(here, '..', '..', 'engine', 'src', 'permissions.ts'), 'utf8')
  const region = seed.slice(seed.indexOf('BUILT_IN_ROLES'), seed.indexOf('BUILT_IN_ROLE_KEYS'))
  assert.ok(region.length > 0, 'engine must declare BUILT_IN_ROLES')
  const names = [...region.matchAll(/^\s*name: "([^"]+)"/gm)].map((m) => m[1])
  assert.deepEqual(new Set(Object.keys(SEEDED_ROLE_NAMES)), new Set(names))
})
