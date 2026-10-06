import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const messagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'messages')
const catalog = (locale: string): Record<string, unknown> => JSON.parse(readFileSync(join(messagesDir, locale, 'ar.json'), 'utf8'))
function leaves(value: unknown, prefix: string, out: Array<[string, string]>) {
  if (typeof value === 'string') out.push([prefix, value])
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) leaves(child, prefix ? `${prefix}.${key}` : key, out)
}
function at(locale: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined, locale)
}
// Technical tokens and shared words remain unchanged; a locale: prefix limits the exemption to that language.
const LOCALE_INVARIANT = new Set([
  'recurring.templateDocPlaceholder', 'recurring.cronLabel', 'recurring.cadenceLabel', 'recurring.table.cadence', 'recurring.no',
  'subscriptions.plansTable.plan', 'subscriptions.subsTable.plan', 'subscriptions.subsTable.mrr', 'subscriptions.planPlaceholder',
  'subscriptions.advanced.colVersion', 'subscriptions.advanced.colNumber', 'fr:subscriptions.advanced.entitlements.colType', 'es:subscriptions.advanced.entitlements.sourcePlan', 'dunning.tokensHint',
])
for (const locale of ['fr', 'es', 'de', 'pt-BR', 'ja', 'zh']) {
  test(`Collections record actions and forms are translated in ${locale}`, () => {
    const sections = ['actions', 'forms', ...(['fr', 'es'].includes(locale) ? ['tabs', 'errors', 'subscriptions', 'recurring', 'dunning'] : [])]
    const en = catalog('en'); const target = catalog(locale)
    for (const section of sections) {
      const wanted: Array<[string, string]> = []; leaves(at(en, `collections.${section}`), '', wanted)
      assert.ok(wanted.length > 0, `English collections.${section} must exist`)
      for (const [path, english] of wanted) {
        const value = at(target, `collections.${section}.${path}`)
        assert.equal(typeof value, 'string', `${locale} collections.${section}.${path} must be translated`)
        assert.ok((value as string).trim(), `${locale} collections.${section}.${path} must not be empty`)
        if (!LOCALE_INVARIANT.has(`${section}.${path}`) && !LOCALE_INVARIANT.has(`${locale}:${section}.${path}`)) assert.notEqual(value, english, `${locale} collections.${section}.${path} must not be the English fallback`)
      }
    }
  })
}
