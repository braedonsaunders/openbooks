import assert from 'node:assert/strict'
import test from 'node:test'
import { quickBooksDesktopConnector } from './quickbooks-desktop-connector'

test('QuickBooks Desktop article describes automatic deletion mirroring, not review-only', () => {
  const body = quickBooksDesktopConnector.body

  // The old claim — deletions reported for review and never voided — is the
  // opposite of the code (sync.ts mirrors unresolved missing refs through an
  // original-period reversal and void). It must stay gone.
  assert.doesNotMatch(body, /never silently\s+voided/i)
  assert.doesNotMatch(body, /reported for review and are never/i)
  // The actual behaviour, with the real disposition path named precisely.
  assert.match(body, /reverses the\s+imported entry in its original period and voids/i)
  assert.match(body, /transaction audit log/i)
  assert.match(body, /\*\*Retain\*\*.*\*\*Void\*\*/s)
  assert.match(body, /\/api\/platform\/connections\/\[id\]\/source-deletions\/\[ref\]/)
})

test('QuickBooks Desktop article states the exact unmapped refusal contract', () => {
  const body = quickBooksDesktopConnector.body

  assert.match(body, /legs posts to an account with no mapping.*naming the account and TxnID/s)
  assert.match(body, /receivables or payables control account.*naming the party, account, and TxnID/s)
  assert.match(body, /never imports a\s+journal with a leg missing/i)
})
