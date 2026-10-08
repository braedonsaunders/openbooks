import assert from 'node:assert/strict'
import test from 'node:test'
import { provisionalResourceForFile, rankResources } from './resource-match.ts'

const candidates = [
  { key: 'parties', label: 'Parties', group: 'Master data', fields: [
    { key: 'displayName', label: 'Name', kind: 'text' as const, required: true },
    { key: 'email', label: 'Email', kind: 'text' as const },
    { key: 'shortCode', label: 'Code', kind: 'text' as const },
  ] },
  { key: 'accounts', label: 'Accounts', group: 'Master data', fields: [
    { key: 'number', label: 'Number', kind: 'text' as const, required: true },
    { key: 'name', label: 'Name', kind: 'text' as const, required: true },
    { key: 'type', label: 'Type', kind: 'select' as const, required: true },
  ] },
]

test('headers rank resources by exact key/label matches, discounted for missing required fields', () => {
  const ranked = rankResources(['Account Number', 'Name', 'Type', 'Number'], candidates)
  assert.equal(ranked[0]!.resource, 'accounts')
  assert.deepEqual(ranked[0]!.mapping, { Name: 'name', Type: 'type', Number: 'number' })
  assert.deepEqual(ranked[0]!.missingRequired, [])
  const parties = ranked.find((match) => match.resource === 'parties')!
  assert.deepEqual(parties.missingRequired, [], 'a header named like the label maps to the field')
  assert.ok(ranked[0]!.score > parties.score)
})

test('a dropped file starts on a provisional resource from its name, falling back to the first importable one', () => {
  const importable = ['accounts', 'parties', 'items', 'txn:customer_invoice', 'txn:vendor_bill']
  assert.equal(provisionalResourceForFile('Accounts Receivable aging.xlsx', importable), 'txn:customer_invoice')
  assert.equal(provisionalResourceForFile('vendor-bills-open.csv', importable), 'txn:vendor_bill')
  assert.equal(provisionalResourceForFile('Chart of Accounts.csv', importable), 'accounts')
  assert.equal(provisionalResourceForFile('customers.csv', importable), 'parties')
  assert.equal(provisionalResourceForFile('export.json', importable), 'accounts')
  assert.equal(provisionalResourceForFile('export.json', []), null)
})
