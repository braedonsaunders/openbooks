import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createTranslator } from 'next-intl'
import {
  englishVendorStrings,
  vendorStrings,
} from './vendor-strings.ts'

/**
 * Vendor-performance sentences resolve through the message catalogs. The
 * 12-month spend labels and the `coalesce(…, 'Unknown')` party display name
 * were hardcoded English in vendor-data.ts. Tier, grade and quadrant codes
 * never localize.
 */

function catalogTranslator(locale: string) {
  const analytics = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'messages', locale, 'analytics.json'), 'utf8'),
  )
  const t = createTranslator({ locale, messages: { analytics }, namespace: 'analytics' })
  return (key: string, values?: Record<string, string | number>): string =>
    t(key, values as Record<string, string | number | Date>)
}

test('the English default pins the exact legacy sentences', () => {
  const s = englishVendorStrings
  assert.equal(s.monthLabel('2026-03'), "Mar '26")
  assert.equal(s.displayVendorName('Unknown'), 'Unknown')
  assert.equal(s.displayVendorName('Acme'), 'Acme')
})

test('the French catalog renders French labels', () => {
  const s = vendorStrings(catalogTranslator('fr'), 'fr')
  assert.equal(s.monthLabel('2026-03'), "mars '26")
  assert.equal(s.displayVendorName('Unknown'), 'Inconnu')
  assert.equal(s.displayVendorName('Acme'), 'Acme')
})

test('the English default matches the en catalog rendering', () => {
  const def = englishVendorStrings
  const en = vendorStrings(catalogTranslator('en'), 'en')
  assert.equal(def.monthLabel('2026-03'), en.monthLabel('2026-03'))
  assert.equal(def.displayVendorName('Unknown'), en.displayVendorName('Unknown'))
  assert.equal(def.displayVendorName('Acme'), en.displayVendorName('Acme'))
})

test('every locale renders the labels without falling back to English', () => {
  const en = vendorStrings(catalogTranslator('en'), 'en')
  for (const locale of ['fr', 'es', 'de', 'pt-BR', 'ja', 'zh']) {
    const s = vendorStrings(catalogTranslator(locale), locale)
    assert.notEqual(s.monthLabel('2026-03'), en.monthLabel('2026-03'), `${locale} monthLabel must not be English fallback`)
    assert.notEqual(s.displayVendorName('Unknown'), en.displayVendorName('Unknown'), `${locale} unknownVendor must not be English fallback`)
  }
})
