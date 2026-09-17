import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * F-t06-025 follow-up: the rates-blocked banner (MissingRatesError →
 * RatesBlockedNotice, code rates-not-derived) shipped with en/es/fr copy
 * only; de/ja/pt-BR/zh fell back to English. Every locale needs its own
 * title + derive action.
 */
const KEYS = ['statement.ratesBlockedTitle', 'statement.ratesBlockedAction'] as const

function reports(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../messages/${locale}/reports.json`, import.meta.url), 'utf8')) as Record<string, unknown>
}

function lookup(catalog: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined), catalog)
}

for (const key of KEYS) {
  test(`rates-blocked banner ${key} is translated in every locale`, () => {
    const source = reports('en')
    assert.ok(typeof lookup(source, key) === 'string' && (lookup(source, key) as string).trim(), `en is missing ${key}`)
    for (const locale of ['es', 'fr', 'de', 'ja', 'pt-BR', 'zh']) {
      const value = lookup(reports(locale), key)
      assert.ok(typeof value === 'string' && value.trim(), `${locale} is missing ${key}`)
      assert.notEqual(value, lookup(source, key), `${locale} falls back to English for ${key}`)
    }
  })
}
