import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const messagesDir = join(dir, '..', '..', '..', '..', 'messages')
const locales = ['de', 'en', 'es', 'fr', 'ja', 'pt-BR', 'zh'] as const

const catalog = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(messagesDir, locale, 'banking.json'), 'utf8'))

function at(locale: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
      locale,
    )
}

// UX-08: the import picker labels must read natively everywhere — a missing
// key renders the raw path next to the Import button.
for (const locale of locales) {
  test(`imports picker copy exists in ${locale}`, () => {
    for (const key of ['imports.accountLabel', 'imports.accountPlaceholder'] as const) {
      const value = at(catalog(locale), key)
      assert.equal(typeof value, 'string', `${locale} ${key} must exist`)
      assert.ok((value as string).trim().length > 0, `${locale} ${key} must not be empty`)
    }
  })
}

for (const locale of locales.filter((candidate) => candidate !== 'en')) {
  test(`imports picker copy is translated in ${locale}`, () => {
    for (const key of ['imports.accountLabel', 'imports.accountPlaceholder'] as const) {
      assert.notEqual(
        at(catalog(locale), key),
        at(catalog('en'), key),
        `${locale} ${key} must not be the English fallback`,
      )
    }
  })
}

const viewSource = readFileSync(join(dir, 'view.ts'), 'utf8')

test('the imports spec binds the picker as header CTA and empty action', () => {
  // One widget serves both slots; the header gates on the reconcile grant.
  assert.match(viewSource, /widget\('import-statement-picker'/)
  assert.match(viewSource, /f\('canImport'\)/)
  assert.match(viewSource, /emptyAction: data\.canImport && data\.importAccounts\.length > 0 \? importPicker : null/)
})

test('the imports loader reads accounts through the shared membership reader', () => {
  // F-t06-001: exactly one predicate decides which accounts are banks.
  assert.match(viewSource, /listReconcilableBankAccounts/)
  assert.doesNotMatch(viewSource, /from accounts/)
  assert.doesNotMatch(viewSource, /passes no drawer and no `emptyAction`/)
})
