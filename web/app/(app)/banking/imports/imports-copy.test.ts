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

// UX-08b: with no reconcilable account the Import History empty state must
// name the prerequisite and offer the setup path — in every locale, not just
// English. A missing key renders the raw path where the guidance belongs.
const noAccountsKeys = ['imports.noAccountsTitle', 'imports.noAccountsDescription', 'imports.noAccountsLink'] as const

for (const locale of locales) {
  test(`imports no-accounts guidance exists in ${locale}`, () => {
    for (const key of noAccountsKeys) {
      const value = at(catalog(locale), key)
      assert.equal(typeof value, 'string', `${locale} ${key} must exist`)
      assert.ok((value as string).trim().length > 0, `${locale} ${key} must not be empty`)
    }
  })
}

for (const locale of locales.filter((candidate) => candidate !== 'en')) {
  test(`imports no-accounts guidance is translated in ${locale}`, () => {
    for (const key of noAccountsKeys) {
      assert.notEqual(
        at(catalog(locale), key),
        at(catalog('en'), key),
        `${locale} ${key} must not be the English fallback`,
      )
    }
  })
}

test('imports no-accounts guidance names the reconcilable prerequisite', () => {
  // The refusal must name the remedy: "reconcilable" by name, and the Chart
  // of Accounts as the place to grant it.
  const english = catalog('en')
  assert.match(
    String(at(english, 'imports.noAccountsDescription')),
    /reconcilable/,
    'the guidance must say the account has to be marked reconcilable',
  )
  assert.match(
    String(at(english, 'imports.noAccountsDescription')),
    /Chart of Accounts/,
    'the guidance must name the Chart of Accounts as the setup location',
  )
})

for (const locale of locales) {
  test(`imports setup link reuses the bank-feeds setup label in ${locale}`, () => {
    // One setup path, one label: the imports empty state must not invent a
    // second wording for the same Chart-of-Accounts link the bank-feeds
    // setup already names.
    assert.equal(
      at(catalog(locale), 'imports.noAccountsLink'),
      at(catalog(locale), 'bankFeeds.client.configure.noEligibleAccountsLink'),
      `${locale} imports setup link must reuse the bank-feeds setup label`,
    )
  })
}

const viewSource = readFileSync(join(dir, 'view.ts'), 'utf8')

test('the imports spec binds the picker as header CTA and empty action', () => {
  // One widget serves both slots; the header gates on the reconcile grant.
  assert.match(viewSource, /widget\('import-statement-picker'/)
  assert.match(viewSource, /f\('canImport'\)/)
  assert.match(
    viewSource,
    /emptyAction: !data\.canImport \? null : data\.importAccounts\.length > 0 \? importPicker : setupAction/,
    'with accounts the empty action stays the import picker; with none it is the setup link',
  )
})

test('the zero-account empty state names the prerequisite and links to setup', () => {
  // UX-08b: no reconcilable account means nothing to import into — the empty
  // state must say so by name and offer the Chart-of-Accounts setup path,
  // never a bare list with no action.
  assert.match(viewSource, /widget: 'open-chart-of-accounts'/, 'the setup action must be the Chart-of-Accounts link widget')
  assert.match(viewSource, /href: data\.setupHref/, 'the setup href travels as loader data, like the reconciliations page')
  assert.match(viewSource, /setupHref: '\/accounts'/, 'the setup path is the Chart of Accounts, never a second path')
  assert.match(viewSource, /t\('imports\.noAccountsTitle'\)/, 'the empty title names the missing reconcilable accounts')
  assert.match(viewSource, /t\('imports\.noAccountsDescription'\)/, 'the empty description names the remedy')
  assert.match(viewSource, /t\('imports\.noAccountsLink'\)/, 'the setup action carries its label')
  assert.match(viewSource, /emptyTitle: data\.emptyTitle/, 'the spec passes the loader-resolved empty title to the list')
  assert.match(viewSource, /emptyDescription: data\.emptyDescription/, 'the spec passes the loader-resolved empty description to the list')
})

test('the picker claims no guidance the empty state does not give', () => {
  // UX-08b: the old comment asserted the empty-state description already
  // named the prerequisite — it did not, which is how the bare state
  // shipped. The claim must not come back.
  const pickerSource = readFileSync(join(dir, 'ImportAccountPicker.tsx'), 'utf8')
  assert.doesNotMatch(
    pickerSource,
    /empty-state description already says/,
    'the misleading comment must stay corrected',
  )
})

test('the imports loader reads accounts through the shared membership reader', () => {
  // F-t06-001: exactly one predicate decides which accounts are banks.
  assert.match(viewSource, /listReconcilableBankAccounts/)
  assert.doesNotMatch(viewSource, /from accounts/)
  assert.doesNotMatch(viewSource, /passes no drawer and no `emptyAction`/)
})
