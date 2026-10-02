import assert from 'node:assert/strict'
import test from 'node:test'
import { setupDomainPayload } from './domain-payload'
import { BILLING_ENTITIES } from './entities/billing'

const policy = BILLING_ENTITIES.find((entity) => entity.key === 'dunning-policies')!
const values = { name: 'Standard', gracePeriodDays: '3', minBalance: '12.3400', replyTo: '', isActive: true,
  stages: [{ sequence: '1', name: 'Reminder', offsetDays: '7', subjectTemplate: 'Invoice {{invoice}}', bodyTemplate: 'Please arrange payment.', escalate: false }] }

test('policy forms send exact decimals, numeric days and native stage JSON to the domain', () => {
  const payload = setupDomainPayload(policy, values)
  assert.ok(payload.ok)
  assert.equal(payload.body.gracePeriodDays, 3)
  assert.equal(payload.body.minBalance, '12.3400')
  assert.equal(payload.body.replyTo, null)
  assert.deepEqual(payload.body.stages, [{ ...values.stages[0], sequence: 1, offsetDays: 7 }])
})

test('an ambiguous money input refuses with its remedy instead of changing the amount', () => {
  const payload = setupDomainPayload(policy, { ...values, minBalance: '1,234' })
  assert.equal(payload.ok, false)
  if (!payload.ok) assert.match(payload.error, /ambiguous|1\.234|1234/i)
})

test('a malformed reminder stage refuses before a domain request is sent', () => {
  const payload = setupDomainPayload(policy, { ...values, stages: [{ ...values.stages[0], offsetDays: '7.5' }] })
  assert.equal(payload.ok, false)
  if (!payload.ok) assert.match(payload.error, /stages row 1.*offsetDays.*whole number/)
})
