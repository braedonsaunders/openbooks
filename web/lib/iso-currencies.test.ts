import assert from 'node:assert/strict'
import test from 'node:test'
import { SUPPORTED_CURRENCIES } from '@openbooks/engine/src/currencies.ts'
import { currencyDisplayName, currencyOptions, ISO_CURRENCIES } from './iso-currencies.ts'

const LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'pt-BR', 'zh']

/**
 * d5 — currency pickers must label every registry code in the user's own
 * language (the countries.ts convention: Intl.DisplayNames at render, no
 * hand-maintained translations), falling back to the registry English name
 * where CLDR has none.
 */
test('currency options cover the whole registry in every locale', () => {
  for (const locale of LOCALES) {
    const options = currencyOptions(locale)
    assert.deepEqual(
      options.map((o) => o.value).sort(),
      SUPPORTED_CURRENCIES.map((c) => c.code).sort(),
      `${locale}: one option per registry code`,
    )
    for (const option of options) {
      assert.ok(option.label.length > option.value.length, `${locale} ${option.value} needs a name label`)
      assert.ok(option.label.startsWith(`${option.value} · `), `${locale} ${option.value} keeps the code-first label shape`)
    }
    const labels = options.map((o) => o.label)
    assert.deepEqual([...labels].sort((a, b) => a.localeCompare(b, locale)), labels, `${locale}: options sort by localized label`)
  }
})

test('localized names come from CLDR, not the English registry', () => {
  assert.equal(currencyDisplayName('USD', 'de'), 'US-Dollar')
  assert.equal(currencyDisplayName('JPY', 'fr'), 'yen japonais')
  assert.equal(currencyDisplayName('JPY', 'ja'), '日本円')
  assert.equal(currencyDisplayName('KWD', 'zh'), '科威特第纳尔')
  // New registry codes localize too — the expansion is not English-only.
  assert.equal(currencyDisplayName('XCG', 'de'), 'Karibischer Gulden')
  assert.equal(currencyDisplayName('XCG', 'es'), 'florín caribeño')
})

test('unknown codes and locales fall back to the registry, never throw', () => {
  const iso = ISO_CURRENCIES.find((c) => c.code === 'USD')!
  assert.equal(currencyDisplayName('USD', 'xx-INVALID'), iso.name)
  assert.equal(currencyDisplayName('ZZZ', 'de'), 'ZZZ')
  assert.equal(currencyOptions('xx-INVALID').length, SUPPORTED_CURRENCIES.length)
})
