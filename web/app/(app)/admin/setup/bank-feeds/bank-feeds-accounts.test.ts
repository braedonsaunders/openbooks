import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// F-t11-005: the connection form's GL picker was empty with no explanation
// on tenants without a reconcilable bank account, so no feed could ever be
// connected. The loader also filtered with its own ad-hoc predicate instead
// of the one banking reader (F-t06-001), and the API accepted feeds on
// inactive or non-bank reconcilable accounts. Pinned here:
//  - the empty picker explains the missing precondition and links to the
//    Chart of Accounts, in every locale;
//  - the loader reads through the unified reconcilable-bank membership.
const dir = dirname(fileURLToPath(import.meta.url))
const messagesDir = join(dir, '..', '..', '..', '..', '..', 'messages')
const LOCALES = ['en', 'fr', 'es', 'de', 'ja', 'zh', 'pt-BR'] as const

const configure = (locale: string): Record<string, unknown> => {
  const catalog = JSON.parse(
    readFileSync(join(messagesDir, locale, 'banking.json'), 'utf8'),
  ) as { bankFeeds?: { client?: { configure?: Record<string, unknown> } } }
  const section = catalog.bankFeeds?.client?.configure
  assert.ok(section, `${locale}/banking.json must carry bankFeeds.client.configure`)
  return section
}

test('bank-feeds empty-picker guidance is translated in every locale', () => {
  const enNote = configure('en').noEligibleAccounts
  const enLink = configure('en').noEligibleAccountsLink
  assert.equal(typeof enNote, 'string')
  assert.equal(typeof enLink, 'string')
  for (const locale of LOCALES) {
    const section = configure(locale)
    for (const key of ['noEligibleAccounts', 'noEligibleAccountsLink'] as const) {
      const message = section[key]
      assert.equal(typeof message, 'string', `${locale} must translate bankFeeds.client.configure.${key}`)
      assert.ok((message as string).length > 0, `${locale} ${key} must not be empty`)
    }
  }
  for (const locale of LOCALES.slice(1)) {
    assert.notEqual(
      configure(locale).noEligibleAccounts,
      enNote,
      `${locale} must not paste the English copy`,
    )
    assert.notEqual(
      configure(locale).noEligibleAccountsLink,
      enLink,
      `${locale} must not paste the English copy`,
    )
  }
})

test('the loader reads the unified reconcilable-bank membership (F-t11-005)', () => {
  const view = readFileSync(join(dir, 'view.ts'), 'utf8')
  assert.match(
    view,
    /listReconcilableBankAccounts/,
    'the loader must use the one banking reader, not its own predicate',
  )
  assert.doesNotMatch(
    view,
    /where org_id = \$\{authz\.user\.orgId\} and reconcilable and not is_summary and is_active/,
    'the ad-hoc reconcilable filter must go',
  )
})

test('the empty picker points at the Chart of Accounts (F-t11-005)', () => {
  const client = readFileSync(join(dir, 'BankFeedsClient.tsx'), 'utf8')
  assert.match(
    client,
    /\{t\("configure\.noEligibleAccounts"\)\}/,
    'the form must explain the empty picker',
  )
  assert.match(
    client,
    /<Link href="\/accounts"[^>]*>\s*\{t\("configure\.noEligibleAccountsLink"\)\}\s*<\/Link>/,
    'the explanation must link to the Chart of Accounts',
  )
})
