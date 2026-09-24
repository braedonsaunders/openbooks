// source-pin-contract: every locale's PSP settlement payload hint names the Stripe Balance Transaction fields (id, type, amount, currency) verbatim; fields from Stripe's documented payload, copy from each locale catalog
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const messagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'messages')
const LOCALES = ['en', 'fr', 'es', 'de', 'ja', 'zh', 'pt-BR'] as const

function payloadShapeHint(locale: string): string {
  const catalog = JSON.parse(readFileSync(join(messagesDir, locale, 'banking.json'), 'utf8')) as {
    pspSettlements?: { payloadShapeHint?: unknown }
  }
  const hint = catalog.pspSettlements?.payloadShapeHint
  assert.equal(typeof hint, 'string', `${locale} must define a settlement payload shape hint`)
  return hint as string
}

test('every locale preserves Stripe settlement payload field names verbatim', () => {
  for (const locale of LOCALES) {
    const hint = payloadShapeHint(locale)
    for (const field of ['"id"', '"type"', '"amount"', '"currency"']) {
      assert.ok(hint.includes(field), `${locale} payload guidance must preserve Stripe field ${field}`)
    }
  }
})
