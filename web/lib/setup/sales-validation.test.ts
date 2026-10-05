import assert from 'node:assert/strict'
import test from 'node:test'
import { validatePromotionWrite } from './sales-validation.ts'

const draftCreate = {
  code: 'QA-PROMO10',
  name: 'QA Ten Percent',
  kind: 'percent',
  status: 'draft',
  percentValue: '10',
}

const calls: unknown[][] = []
const executor = {
  execute: async (...args: unknown[]) => {
    calls.push(args)
    return { rows: [] }
  },
}

test('a draft-by-default promotion create passes validation without a transition', async () => {
  // Creation stores its opening status directly; comparing it against no
  // previous status refused every draft create with the transition remedy.
  calls.length = 0
  const result = await validatePromotionWrite({ orgId: 'org-1', body: { ...draftCreate }, rowId: undefined, executor: executor as never })
  assert.equal(result, undefined)
  assert.deepEqual(calls, [], 'a create reads no current row')
})

test('leaving the status unchanged on edit passes validation', async () => {
  const reading = {
    execute: async () => ({
      rows: [{
        code: 'QA-PROMO10', name: 'QA Ten Percent', description: null, kind: 'percent', status: 'draft',
        percent_value: '10', amount_minor: null, currency: null, buy_quantity: null, get_quantity: null,
        starts_at: null, ends_at: null, usage_limit: null, discount_account_id: null,
      }],
    }),
  }
  const result = await validatePromotionWrite({ orgId: 'org-1', body: {}, rowId: 'promo-1', executor: reading as never })
  assert.equal(result, undefined)
})

test('an illegal archived-to-active edit keeps its named remedy', async () => {
  const reading = {
    execute: async () => ({
      rows: [{
        code: 'QA-PROMO10', name: 'QA Ten Percent', description: null, kind: 'percent', status: 'archived',
        percent_value: '10', amount_minor: null, currency: null, buy_quantity: null, get_quantity: null,
        starts_at: null, ends_at: null, usage_limit: null, discount_account_id: null,
      }],
    }),
  }
  const result = await validatePromotionWrite({
    orgId: 'org-1', body: { status: 'active' }, rowId: 'promo-1', executor: reading as never,
  })
  assert.match(String(result), /new promotion/)
})
