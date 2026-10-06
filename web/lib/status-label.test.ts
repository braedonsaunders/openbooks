import assert from 'node:assert/strict'
import test from 'node:test'
import { statusLabel, statusMessageKey } from './status-label.ts'

const common = (await import('../messages/en/common.json', { with: { type: 'json' } })).default

const catalog = common as unknown as { status: Record<string, string> }
const translate = (key: string) => catalog.status[key.replace(/^status\./, '')] ?? key
const has = (key: string) => key.replace(/^status\./, '') in catalog.status

test('stored statuses translate through their camelCase catalog key', () => {
  assert.equal(statusMessageKey('pending_approval'), 'pendingApproval')
  assert.equal(statusMessageKey('partially_paid'), 'partiallyPaid')
  assert.equal(statusLabel('draft', translate, has), catalog.status.draft)
  assert.equal(statusLabel('partially_paid', translate, has), catalog.status.partiallyPaid)
})

test('pending approval never reads as the unrelated raw catalog key', () => {
  assert.notEqual(catalog.status.pending_approval, catalog.status.pendingApproval)
  assert.equal(statusLabel('pending_approval', translate, has), catalog.status.pendingApproval)
})

test('a status the catalog does not name reads as plain words, never a key path', () => {
  assert.equal(statusLabel('in_service', translate, has), 'in service')
})
