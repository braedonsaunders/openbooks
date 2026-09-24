import assert from 'node:assert/strict'
import test from 'node:test'
import { displayListViewName } from './display.ts'

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
