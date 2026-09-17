import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const messagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'messages')
const catalog = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(messagesDir, locale, 'ar.json'), 'utf8'))

function leaves(value: unknown, prefix: string, out: Array<[string, string]>) {
  if (typeof value === 'string') out.push([prefix, value])
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) leaves(child, prefix ? `${prefix}.${key}` : key, out)
  }
}

function at(locale: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (
    node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined
  ), locale)
}

// F-x6-001 item 3: the /collections recurring surface (tabs, form, table,
// empty state) rendered entirely in English under fr because fr/ar.json had
// no collections section at all. Every English string in the filed surface
// must have a real fr translation.
// F-x6-002: the same coverage extends to es plus the subscriptions and
// dunning bodies in both locales.
const sectionsByLocale: Record<string, readonly string[]> = {
  fr: ['tabs', 'errors', 'subscriptions', 'recurring', 'dunning'],
  es: ['tabs', 'errors', 'subscriptions', 'recurring', 'dunning'],
}
// Document-number examples, proper nouns, technical tokens kept verbatim
// ("Tokens:", "Cron", "MRR"), and words spelled identically in the target
// language are the same string in every locale.
const LOCALE_INVARIANT = new Set([
  'recurring.templateDocPlaceholder',
  'recurring.cronLabel',
  'recurring.cadenceLabel',
  'recurring.table.cadence',
  'recurring.no',
  'subscriptions.plansTable.plan',
  'subscriptions.subsTable.plan',
  'subscriptions.subsTable.mrr',
  'subscriptions.planPlaceholder',
  'dunning.tokensHint',
])
for (const [locale, sections] of Object.entries(sectionsByLocale)) {
  for (const section of sections) {
    test(`collections.${section} is translated in ${locale}`, () => {
      const en = catalog('en')
      const target = catalog(locale)
      const wanted: Array<[string, string]> = []
      leaves(at(en, `collections.${section}`), '', wanted)
      assert.ok(wanted.length > 0, `en collections.${section} must exist as reference`)
      for (const [path, english] of wanted) {
        const value = at(target, `collections.${section}.${path}`)
        assert.equal(typeof value, 'string', `${locale} collections.${section}.${path} must be translated`)
        assert.ok(
          (value as string).trim().length > 0,
          `${locale} collections.${section}.${path} must not be empty`,
        )
        if (!LOCALE_INVARIANT.has(`${section}.${path}`)) {
          assert.notEqual(
            value,
            english,
            `${locale} collections.${section}.${path} must not be the English fallback`,
          )
        }
      }
    })
  }
}
