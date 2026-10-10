import assert from 'node:assert/strict'
import test from 'node:test'
import { applyLineDefault, followTermsDueDate, itemChangeRequests, type DefaultsLine } from './document-line-defaults'

const ctx = {
  accountIds: new Set(['acct-4100', 'acct-4200', 'acct-6100']),
  taxProfileValues: new Set(['code:hst-on', 'code:zr', 'group:combo']),
  applyTax: true,
}
const line = (overrides: Partial<DefaultsLine> = {}): DefaultsLine => ({
  clientKey: 'k1', lineId: '', itemId: '', accountId: '', taxProfileId: '', ...overrides,
})

test('choosing an item on a new line requests its defaults; saved lines keep their coding', () => {
  const first = itemChangeRequests(new Map(), [
    line({ clientKey: 'saved', lineId: 'line-1', itemId: 'item-a', accountId: 'acct-4200' }),
    line({ clientKey: 'new', itemId: 'item-b' }),
    line({ clientKey: 'blank' }),
  ])
  assert.deepEqual(first.requests, [{ clientKey: 'new', itemId: 'item-b' }])

  const changed = itemChangeRequests(first.seen, [
    line({ clientKey: 'saved', lineId: 'line-1', itemId: 'item-c', accountId: 'acct-4200' }),
    line({ clientKey: 'new', itemId: 'item-b' }),
    line({ clientKey: 'blank', itemId: 'item-a' }),
  ])
  assert.deepEqual(changed.requests, [
    { clientKey: 'saved', itemId: 'item-c' },
    { clientKey: 'blank', itemId: 'item-a' },
  ])
  assert.deepEqual(itemChangeRequests(changed.seen, [line({ clientKey: 'blank', itemId: 'item-a' })]).requests, [])
})

test('an item fills a blank line with its account and tax code', () => {
  const { row, applied } = applyLineDefault(line({ itemId: 'item-a' }), { itemId: 'item-a', accountId: 'acct-4100', taxCodeId: 'hst-on' }, undefined, ctx)
  assert.equal(row.accountId, 'acct-4100')
  assert.equal(row.taxProfileId, 'code:hst-on')
  assert.deepEqual(applied, { itemId: 'item-a', accountId: 'acct-4100', taxProfileId: 'code:hst-on' })
})

test('switching item replaces untouched defaults and keeps operator choices', () => {
  const previous = { itemId: 'item-a', accountId: 'acct-4100', taxProfileId: 'code:hst-on' }
  const untouched = applyLineDefault(line({ itemId: 'item-b', accountId: 'acct-4100', taxProfileId: 'code:hst-on' }),
    { itemId: 'item-b', accountId: 'acct-4200', taxCodeId: 'zr' }, previous, ctx)
  assert.equal(untouched.row.accountId, 'acct-4200')
  assert.equal(untouched.row.taxProfileId, 'code:zr')

  const overridden = applyLineDefault(line({ itemId: 'item-b', accountId: 'acct-6100', taxProfileId: 'group:combo' }),
    { itemId: 'item-b', accountId: 'acct-4200', taxCodeId: 'zr' }, previous, ctx)
  assert.equal(overridden.row.accountId, 'acct-6100')
  assert.equal(overridden.row.taxProfileId, 'group:combo')
})

test('a missing or unofferable default clears a following field instead of keeping the old item coding', () => {
  const previous = { itemId: 'item-a', accountId: 'acct-4100', taxProfileId: 'code:hst-on' }
  const { row } = applyLineDefault(line({ itemId: 'item-b', accountId: 'acct-4100', taxProfileId: 'code:hst-on' }),
    { itemId: 'item-b', accountId: 'acct-outside-picker', taxCodeId: null }, previous, ctx)
  assert.equal(row.accountId, '')
  assert.equal(row.taxProfileId, '')
})

test('tax is left alone when the kind resolves tax automatically', () => {
  const { row } = applyLineDefault(line({ itemId: 'item-a' }), { itemId: 'item-a', accountId: 'acct-4100', taxCodeId: 'hst-on' }, undefined, { ...ctx, applyTax: false })
  assert.equal(row.accountId, 'acct-4100')
  assert.equal(row.taxProfileId, '')
})

test('the due date follows terms until the operator types one', () => {
  assert.equal(followTermsDueDate({ dueDate: '', overridden: false, lastDerived: null, derived: '2026-08-04' }), '2026-08-04')
  // A new document date recomputes a derived due date.
  assert.equal(followTermsDueDate({ dueDate: '2026-08-04', overridden: false, lastDerived: '2026-08-04', derived: '2026-08-10' }), '2026-08-10')
  // A typed due date survives a date or party change.
  assert.equal(followTermsDueDate({ dueDate: '2026-09-01', overridden: true, lastDerived: '2026-08-04', derived: '2026-08-10' }), '2026-09-01')
  // A party without terms drops only the due date the old terms implied.
  assert.equal(followTermsDueDate({ dueDate: '2026-08-04', overridden: false, lastDerived: '2026-08-04', derived: null }), '')
  assert.equal(followTermsDueDate({ dueDate: '2026-09-01', overridden: true, lastDerived: '2026-08-04', derived: null }), '2026-09-01')
})
