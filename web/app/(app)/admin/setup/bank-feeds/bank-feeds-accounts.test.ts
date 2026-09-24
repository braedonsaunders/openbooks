import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { registerHooks } from 'node:module'

// Only server-only is stubbed: the spec is pure data binding and must load
// the real view module.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { bankFeedsSpec } = (await import('./view')) as typeof import('./view')
import type { BankFeedsData } from './view'

// F-t11-005: the connection form's GL picker was empty with no explanation
// on tenants without a reconcilable bank account, so no feed could ever be
// connected. Pinned here: the empty picker explains the missing precondition
// and links to the Chart of Accounts, in every locale.
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

// The loader's eligible accounts reach the workspace widget unchanged: the
// picker the client renders is exactly the loader's list, never a second
// query or a renamed field.
test('the spec binds the loader accounts and daemon to the workspace widget', () => {
  const data: BankFeedsData = {
    connections: [],
    sftpServers: [],
    sftpSchedules: [],
    accounts: [{ id: 'acc-1', label: '1000 · Operating Cash' }],
    daemon: { enabled: false, port: 0, host: 'localhost', fingerprint: '' },
  }
  const serialized = JSON.stringify(bankFeedsSpec(data))
  assert.match(serialized, /bank-feeds-workspace/)
  assert.match(serialized, /1000 · Operating Cash/)
  assert.match(serialized, /localhost/)
})
