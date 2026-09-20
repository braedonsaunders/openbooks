import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { displayListViewName, SEEDED_DEFAULT_VIEW_NAME } from './display.ts'

// F-x6-001 item 2: the provisioned baseline view row is seeded in English
// ("Default view"), which shadowed the translated views.defaultName fallback
// so every list switcher read "Vue Default view". An unrenamed baseline
// renders as the translated system default; a renamed row keeps its name.
test('an unrenamed seeded baseline renders as the translated default', () => {
  assert.equal(displayListViewName('Default view', 'Vue par défaut'), 'Vue par défaut')
  assert.equal(displayListViewName('Default view', 'Default view'), 'Default view')
})

test('a missing row falls back to the translated default', () => {
  assert.equal(displayListViewName(null, 'Vue par défaut'), 'Vue par défaut')
  assert.equal(displayListViewName(undefined, 'Vue par défaut'), 'Vue par défaut')
})

test('a renamed view keeps its own name in every locale', () => {
  assert.equal(displayListViewName('Mes factures', 'Vue par défaut'), 'Mes factures')
  assert.equal(displayListViewName('My invoices', 'Default view'), 'My invoices')
})

test('the seeded-name reference matches the engine provisioning seed', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const seed = readFileSync(join(here, '..', '..', '..', 'engine', 'src', 'provisioning', 'customization-defaults.ts'), 'utf8')
  const match = seed.match(/DEFAULT_VIEW_NAME = "([^"]+)"/)
  assert.ok(match, 'engine seed must declare DEFAULT_VIEW_NAME')
  assert.equal(SEEDED_DEFAULT_VIEW_NAME, match[1], 'display helper must track the engine seed name')
})
